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
