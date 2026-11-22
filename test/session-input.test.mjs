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

test('查看归档队列只请求取消归档和列表，保留草稿设置', async t => {
  const modelSelection = { provider: 'openai', model: 'selected' }
  const model = { getSnapshot: () => modelSelection, clear() { assert.fail('查看队列不能清除模型草稿') } }
  const permission = { getSnapshot: () => ':read-only', clear() { assert.fail('查看队列不能清除权限草稿') } }
  const state = { archived: true }
  let queue = []
  const history = {
    session: { getSnapshot: () => state },
    events: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
    queueStore: { getSnapshot: () => queue, subscribe: () => () => {} },
    captureQueueView: () => data => { queue = data },
    updateState: edit => edit(state),
  }
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = originalDocument })
  t.mock.method(globalThis, 'fetch', async (_, request) => {
    assert.deepEqual(JSON.parse(request.body), { threadId: 'native', action: 'queue', operation: 'list', unarchive: true })
    return Response.json({ data: [{ id: 'queued' }] })
  })
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history, model, permission)
  assert.deepEqual(await input.viewQueue(), { ok: true, value: { empty: false } })
})

test('工作树草稿失败后保留提交身份，成功时接纳并打开原生目标', async t => {
  const worktree = { kind: 'new', id: crypto.randomUUID(), baseRef: 'refs/heads/main' }
  const thread = { id: 'new-native', cwd: '/new-worktree' }
  const lifecycle = []
  let selected = worktree
  let fail = true
  const draft = { getSnapshot: () => selected, clear(value) { if (selected === value) selected = undefined } }
  const model = { getSnapshot: () => undefined, clear() {} }
  const state = { blank: true, pendingSubmissions: [] }
  const history = {
    session: { getSnapshot: () => state },
    events: { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} },
    queueStore: { getSnapshot: () => [], subscribe: () => () => {} },
    updateState: edit => edit(state),
  }
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = originalDocument })
  t.mock.method(globalThis, 'fetch', async (_, request) => {
    const sent = JSON.parse(request.body)
    assert.equal(sent.threadId, 'native-draft')
    assert.deepEqual(sent.worktree, worktree)
    assert.equal(sent.clientUserMessageId, worktree.id)
    return fail ? Response.json({ error: 'retry' }, { status: 409 }) : Response.json({ thread })
  })
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native-draft', history, model, undefined,
    draft, result => lifecycle.push(result.thread.id))
  async function send() {
    const { requestId } = input.beginSubmission({ mode: 'queue', text: '开始', attachments: [],
      onAccept: () => lifecycle.push('accepted'), onRetire: result => lifecycle.push(result.reason) })
    return input.prompt([{ type: 'text', text: '开始' }], 'queue', undefined, requestId)
  }
  assert.equal((await send()).ok, false)
  assert.equal(selected, worktree)
  fail = false
  assert.equal((await send()).ok, true)
  assert.equal(selected, undefined)
  assert.deepEqual(lifecycle, ['failed', 'accepted', 'observed', thread.id])
})
