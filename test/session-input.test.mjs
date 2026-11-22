import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionInput } from '../src/client/native-dsh/session-input.js'

test('原生队列曾确认图片送达时，后续 HTTP 失败不会恢复草稿', async t => {
  const reply = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', () => reply.promise)
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { delete globalThis.document })

  let queue = []
  let queueChanged
  const state = { pendingSubmissions: [] }
  const history = {
    session: { getSnapshot: () => ({ running: true }) },
    events: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
    queueStore: { getSnapshot: () => queue, subscribe(listener) { queueChanged = listener; return () => {} } },
    updateState: edit => edit(state),
  }
  const ctx = { effect: effect => t.after(effect()) }
  const input = createSessionInput(ctx, 'native-thread', history, { getSnapshot: () => undefined, clear() {} })
  const lifecycle = []
  const { requestId } = input.beginSubmission({ mode: 'queue', text: '', attachments: [{ type: 'image' }],
    onAccept: () => lifecycle.push('accepted'), onRetire: settlement => lifecycle.push(settlement.reason) })
  const sending = input.prompt([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }], 'queue', undefined, requestId)

  queue = [{ clientUserMessageId: requestId }]
  queueChanged()
  queue = []
  queueChanged()
  reply.resolve(Response.json({ error: 'HTTP response lost' }, { status: 503 }))

  assert.deepEqual(lifecycle, ['accepted', 'observed'])
  assert.equal((await sending).ok, true)
  assert.deepEqual(state.pendingSubmissions, [])
  assert.equal(state.promptError, null)
})

test('归档草稿的模型和权限随提交传递，遇到失败或空队列时保留', async t => {
  const model = { provider: 'openai', model: 'selected', reasoningEffort: 'high' }
  const profileId = ':read-only'
  const confirmed = { profileId, source: 'runtime' }
  const requests = []
  let projection = { permission: undefined }
  const responses = [Response.json({ error: 'fixture rejected' }, { status: 409 }), Response.json({ queueEmpty: true }), Response.json({ permission: confirmed })]
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  t.mock.method(globalThis, 'fetch', async (_, request) => {
    requests.push(JSON.parse(request.body))
    if (responses.length === 1) projection = { permission: { profileId: ':workspace', source: 'saved' } }
    return responses.shift()
  })
  const draft = initial => {
    let value = initial
    return { getSnapshot: () => value, clear(selection) { if (selection === value) value = undefined } }
  }
  const modelDraft = draft(model)
  const permissionDraft = draft(profileId)
  const state = { pendingSubmissions: [], archived: true }
  const history = {
    session: { getSnapshot: () => state, projections: { faceOf: () => ({ getSnapshot: () => projection }) },
      publishPermission(permission) { projection = { permission } } },
    events: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
    queueStore: { getSnapshot: () => [], subscribe: () => () => {} },
    updateState: edit => edit(state),
  }
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history, modelDraft, permissionDraft)
  assert.equal((await input.prompt([{ type: 'text', text: '继续' }], 'queue')).ok, false)
  assert.equal((await input.startQueue()).ok, true)
  assert.deepEqual(modelDraft.getSnapshot(), model)
  assert.equal(permissionDraft.getSnapshot(), profileId)
  assert.equal((await input.startQueue()).ok, true)
  assert.equal(modelDraft.getSnapshot(), undefined)
  assert.equal(permissionDraft.getSnapshot(), undefined)
  assert.deepEqual(projection.permission, confirmed)
  assert.deepEqual(requests.map(({ action, unarchive, modelDraft, permissionDraft }) => [action, unarchive, modelDraft, permissionDraft]),
    [['prompt', true, model, profileId], ['queue', true, model, profileId], ['queue', true, model, profileId]])
})
