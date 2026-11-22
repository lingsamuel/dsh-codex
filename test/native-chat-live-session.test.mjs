import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const storeModule = `data:text/javascript,${encodeURIComponent(`
  export function createSnapshotStore(initial) {
    let value = initial
    return { getSnapshot: () => value, subscribe: () => () => {}, set(next) { value = next },
      update(edit) { const next = structuredClone(value); edit(next); value = next } }
  }
`)}`
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-client-store') return { shortCircuit: true, url: storeModule }
    return next(specifier, context)
  },
})
const { createCodexHistory } = await import('../src/client/native-dsh/session-events.js')
hook.deregister()

function mockTransport(t) {
  const original = { document: globalThis.document, EventSource: globalThis.EventSource, fetch: globalThis.fetch }
  let source
  globalThis.document = { baseURI: 'http://127.0.0.1:3190/' }
  globalThis.EventSource = class {
    constructor(url) { source = this; this.url = url }
    close() { this.closed = true }
  }
  t.after(() => Object.assign(globalThis, original))
  return () => source
}

function turn(id, status, items) {
  return { id, status, startedAt: 100, items }
}

const ask = { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'native question' }] }
const answer = { id: 'answer', type: 'agentMessage', text: 'native reply' }

test('stock window appends native tail changes, prepends older history, and keeps both during reconnect', async t => {
  const currentSource = mockTransport(t)
  const received = []
  let dispose
  const reading = []
  const history = createCodexHistory({ effect(callback) { dispose = callback() } }, { id: 'thread' }, {
    setStatus: (...update) => received.push(update),
    setReadState: (...update) => reading.push(update),
    applyUnread: update => reading.push(update),
  })
  const source = currentSource()
  const emit = frame => source.onmessage({ data: JSON.stringify(frame) })
  assert.equal(source.url.searchParams.get('threadId'), 'thread')

  const active = { type: 'active', activeFlags: [] }
  const readState = { firstUnread: null, revision: 'one' }
  await emit({ type: 'snapshot', page: { data: [turn('new', 'inProgress', [ask])], nextCursor: 'older' }, status: active, readState, mode: 'live' })
  await history.ready
  assert.deepEqual(received, [['thread', active]])
  const unread = { type: 'unread', replace: true, added: ['background'], removed: [] }
  await emit(unread)
  await emit({ type: 'notification', notification: { method: 'thread/readState/changed', params: { threadId: 'background', readState } } })
  assert.deepEqual(reading, [['thread', readState], unread, ['background', readState]])
  const initial = history.events.getSnapshot()
  assert.equal(history.session.getSnapshot().running, true)
  assert.equal(initial.change.kind, 'replace')

  await emit({ type: 'change', turn: { id: 'new', status: 'inProgress' }, items: [answer] })
  const appended = history.events.getSnapshot()
  assert.equal(appended.change.kind, 'append')
  assert.equal(appended.change.entries[0].event.data.message.id, 'answer')
  assert.strictEqual(appended.entries[0], initial.entries[0])

  const corrected = { ...answer, text: 'corrected reply' }
  await emit({ type: 'change', turn: { id: 'new', status: 'inProgress' }, items: [corrected] })
  const edited = history.events.getSnapshot()
  assert.equal(edited.change.kind, 'replace')
  assert.strictEqual(edited.entries[0], initial.entries[0])
  assert.equal(edited.entries.at(-1).event.data.message.content[0].text, corrected.text)

  const old = turn('old', 'completed', [{ ...ask, id: 'old-ask' }])
  globalThis.fetch = async url => {
    assert.equal(url.searchParams.get('cursor'), 'older')
    return Response.json({ data: [old], nextCursor: null })
  }
  await history.session.loadOlder()
  const expanded = history.events.getSnapshot()
  assert.equal(expanded.change.kind, 'prepend')
  assert.equal(expanded.entries[0].event.data.codexTurnId, 'old')
  assert.strictEqual(expanded.entries.at(-1), edited.entries.at(-1))

  const notification = { method: 'thread/status/changed', params: { threadId: 'thread', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } }
  await emit({ type: 'notification', notification })
  await emit({ type: 'notification', notification: { ...notification, params: { ...notification.params, threadId: 'background' } } })
  assert.deepEqual(received, [['thread', active], ['thread', notification.params.status], ['background', notification.params.status]])
  assert.deepEqual(history.session.getSnapshot().live.status.activeFlags, ['waitingOnApproval'])
  await source.onerror()
  assert.equal(history.session.getSnapshot().running, false)
  assert.equal(history.session.getSnapshot().live.mode, 'disconnected')

  await emit({ type: 'snapshot', page: { data: [turn('new', 'completed', [ask, corrected])], nextCursor: 'stale-cursor' }, status: { type: 'idle' }, mode: 'live' })
  const reconnected = history.events.getSnapshot()
  assert.deepEqual(received.at(-1), ['thread', { type: 'idle' }])
  assert.equal(reconnected.change.kind, 'append')
  assert.strictEqual(reconnected.entries[0], expanded.entries[0])
  assert.equal(reconnected.hasMore, false)
  assert.equal(history.session.getSnapshot().live.lastTurnStatus, 'completed')
  dispose()
  assert.equal(source.closed, true)
})

test('one initial history request keeps the view usable when SSE cannot open', async t => {
  const currentSource = mockTransport(t)
  let historyRequests = 0
  globalThis.fetch = async url => {
    assert.equal(url.pathname, '/api/codex/turns')
    historyRequests++
    return Response.json({ data: [turn('first', 'completed', [ask])], nextCursor: null })
  }
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const source = currentSource()
  await source.onerror()
  await source.onerror()
  await history.ready
  assert.equal(historyRequests, 1)
  assert.equal(history.session.getSnapshot().openState, 'open')
  assert.ok(history.events.getSnapshot().entries.some(entry => entry.event.type === 'user/message'))
})

test('a reconnect across a page gap fills that gap without discarding the existing window', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const first = turn('first', 'completed', [ask])
  await emit({ type: 'snapshot', page: { data: [first], nextCursor: null }, mode: 'live' })
  const firstEvent = history.events.getSnapshot().entries[0]
  let pages = 0
  globalThis.fetch = async url => {
    assert.equal(url.searchParams.get('cursor'), 'gap')
    pages++
    return Response.json({ data: [turn('second', 'completed', []), first], nextCursor: 'unused' })
  }
  await emit({ type: 'snapshot', page: { data: [turn('third', 'completed', [])], nextCursor: 'gap' }, mode: 'live' })
  const final = history.events.getSnapshot()
  assert.equal(pages, 1)
  assert.equal(final.change.kind, 'append')
  assert.deepEqual(final.entries.filter(entry => entry.event.type === 'turn/start').map(entry => entry.event.data.codexTurnId), ['first', 'second', 'third'])
  assert.strictEqual(final.entries[0], firstEvent)
  assert.equal(final.hasMore, false)
})

test('an authoritative reconnect tail drops rolled-back turns and keeps earlier records', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const older = turn('earlier', 'completed', [ask])
  const removed = turn('removed', 'completed', [answer])
  const snapshot = data => emit({ type: 'snapshot', page: { data, nextCursor: null }, mode: 'live' })
  await snapshot([removed, older])
  const previous = history.events.getSnapshot().entries[0]
  await snapshot([older])
  const current = history.events.getSnapshot()
  assert.equal(current.change.kind, 'replace')
  assert.strictEqual(current.entries[0], previous)
  assert.equal(current.entries.some(entry => entry.event.data.codexTurnId === 'removed'), false)
  await snapshot([])
  assert.deepEqual(history.events.getSnapshot().entries, [])
  assert.equal(history.session.getSnapshot().live.lastTurnStatus, undefined)
})
