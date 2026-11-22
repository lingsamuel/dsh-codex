import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const storeModule = `data:text/javascript,${encodeURIComponent(`
  export function createSnapshotStore(initial) {
    let value = initial
    const listeners = new Set()
    function set(next) { value = next; for (const notify of listeners) notify() }
    return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, set,
      update(edit) { const next = structuredClone(value); edit(next); set(next) } }
  }
`)}`
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-client-store') return { shortCircuit: true, url: storeModule }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives' || specifier === 'react') {
      const url = 'data:text/javascript,export const Toast = null; export const createElement = () => null'
      return { shortCircuit: true, url }
    }
    return next(specifier, context)
  },
})
const { createCodexHistory } = await import('../src/client/native-dsh/session-events.js')
const { createSessionInput } = await import('../src/client/native-dsh/session-input.js')
const { provideCodexControllers } = await import('../src/client/native-dsh/controllers.js')
const { createHistoryCatalog } = await import('../src/client/catalog.js')
const { installPermissions } = await import('../src/client/native-dsh/permissions.js')
hook.deregister()
const { createSnapshotStore } = await import(storeModule)

function mockTransport(t) {
  const original = { window: globalThis.window, document: globalThis.document, EventSource: globalThis.EventSource, fetch: globalThis.fetch }
  let source
  globalThis.window = new EventTarget()
  globalThis.document = { baseURI: 'http://127.0.0.1:3190/' }
  globalThis.EventSource = class extends EventTarget {
    constructor(url) { super(); source = this; this.url = url }
    close() { this.closed = true }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => Object.assign(globalThis, original))
  return () => source
}

function turn(id, status, items) {
  return { id, status, startedAt: 100, items }
}

const ask = { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'native question' }] }
const answer = { id: 'answer', type: 'agentMessage', text: 'native reply' }

test('重连读取的权限缓存只填补缺失状态，不覆盖较新的原生权限', async t => {
  mockTransport(t)
  const owner = new AbortController()
  const catalog = createSnapshotStore({ selected: { id: 'thread' } })
  const generation = createSnapshotStore(0)
  const cached = { profileId: ':read-only', source: 'saved' }
  const native = { profileId: ':workspace', source: 'saved' }
  const projection = createSnapshotStore({ permission: native })
  const session = { projections: { faceOf: () => projection }, publishPermission: permission => projection.set({ permission }) }
  const remote = {}
  const cleanups = []
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    slots: { entries: () => [], inject() {} },
    on: () => () => {},
    effect(callback) { cleanups.push(callback()) },
    inject(keys, callback) {
      if (!keys.includes('remote.permissionPresets')) return
      callback({ ...this, connection: { generation }, get: () => remote, sessions: { binding: () => ({ session }) } })
    },
  }
  globalThis.fetch = async () => Response.json({ profiles: [], permission: cached })
  t.after(() => { owner.abort(); for (const stop of cleanups.reverse()) stop?.() })
  installPermissions(ctx, catalog, owner.signal)
  await new Promise(setImmediate)
  assert.deepEqual(projection.getSnapshot().permission, native)
  projection.set({ permission: undefined })
  generation.set(1)
  await new Promise(setImmediate)
  assert.deepEqual(projection.getSnapshot().permission, cached)
})

test('网页分叉、CLI 增量和重连补齐共用手动顺序', async t => {
  const currentSource = mockTransport(t)
  const now = Math.floor(Date.now() / 1000)
  const openedAt = now * 1000 + 500
  t.mock.method(Date, 'now', () => openedAt)
  function threadIdAt(offset) {
    const time = (openedAt + offset).toString(16).padStart(12, '0')
    return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-000000000001`
  }
  const source = { id: 'source', cwd: '/workspace', createdAt: now - 600, updatedAt: now - 60, preview: 'Existing' }
  const legacy = { ...source, id: threadIdAt(-1), createdAt: now, updatedAt: now + 10 }
  const fork = { ...source, id: 'fork' }
  let indexed = [source, { ...source, id: 'another' }]
  globalThis.fetch = async (url, { body } = {}) => {
    if (url.pathname.endsWith('/catalog')) {
      const complete = url.searchParams.has('complete')
      return Response.json({ projects: [], threads: complete ? [...indexed, legacy] : indexed, workspacePaths: {}, complete })
    }
    if (url.pathname.endsWith('/archived')) return Response.json({ threads: [], workspacePaths: {} })
    assert.equal(url.pathname, '/api/codex/thread-action')
    assert.deepEqual(JSON.parse(body), { action: 'fork', threadId: source.id })
    return Response.json({ thread: fork, workspacePaths: {} })
  }
  const controller = new AbortController()
  t.after(() => controller.abort())
  const catalog = createHistoryCatalog(controller.signal)
  const emit = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const manualOrder = createSnapshotStore({
    orderBy: 'manual',
    sessionOrderByAccount: {
      'directory:/workspace': ['another', 'source'],
      '__flat_session_order__': ['source', 'unrelated', 'another'],
      'directory:/other': ['unrelated'],
    },
  })
  const storeInstance = { ...manualOrder, actions: {
    syncSessionOrders: orders => manualOrder.update(state => Object.assign(state.sessionOrderByAccount, orders)),
  } }
  const services = new Map()
  const ctx = {
    slots: { entriesOfSlot: () => [{ store: { create: () => storeInstance } }], subscribe() {} },
    provide: (key, value) => services.set(key, value),
    effect: install => install(),
    inject() {},
  }
  provideCodexControllers(ctx, catalog)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle()
  assert.ok(services.get('sessions').list.getSnapshot().byId[legacy.id])

  function assertOrder(leading) {
    assert.deepEqual(manualOrder.getSnapshot().sessionOrderByAccount, {
      'directory:/workspace': [...leading, 'another', 'source'],
      '__flat_session_order__': [...leading, 'source', 'unrelated', 'another'],
      'directory:/other': ['unrelated'],
    })
  }
  assertOrder([])
  const gap = { ...source, id: threadIdAt(1), createdAt: now, updatedAt: now }
  indexed = [...indexed, gap]
  emit({ type: 'catalog-ready' })
  await settle()
  assertOrder([gap.id])

  await services.get('sessions').fork({ sessionId: source.id,
    onCreated: () => assertOrder(['fork', gap.id]) })

  const cliDraft = { ...source, id: threadIdAt(2), source: 'cli', blank: true, status: { type: 'idle' },
    preview: '', createdAt: now, updatedAt: now }
  emit({ type: 'thread', id: cliDraft.id, thread: cliDraft })
  assertOrder(['fork', gap.id])
  emit({ type: 'notification', notification: { method: 'thread/status/changed',
    params: { threadId: cliDraft.id, status: { type: 'active', activeFlags: [] } } } })
  assertOrder([cliDraft.id, 'fork', gap.id])
  const cli = { ...cliDraft, blank: false, preview: 'CLI first message' }
  emit({ type: 'notification', notification: { method: 'thread/status/changed',
    params: { threadId: cli.id, status: cli.status } }, thread: cli })
  assertOrder([cli.id, 'fork', gap.id])

  const missed = { ...cli, id: 'missed', createdAt: now + 2 }
  indexed = [...indexed, fork, cli, missed, { ...legacy, id: 'backfill' }]
  emit({ type: 'catalog-ready' })
  await settle()
  assert.ok(services.get('sessions').list.getSnapshot().byId.backfill)
  assertOrder(['missed', cli.id, 'fork', gap.id])
  emit({ type: 'thread', id: cli.id, thread: { ...cli, updatedAt: now + 20 } })
  assertOrder(['missed', cli.id, 'fork', gap.id])

  manualOrder.update(state => { state.orderBy = 'updated' })
  fork.id = 'recent-fork'
  await services.get('sessions').fork({ sessionId: source.id })
  assertOrder(['missed', cli.id, 'fork', gap.id])
})

test('原生队列保留条目身份，活跃轮次来自 Codex 历史头部', async t => {
  const active = { type: 'active', activeFlags: [] }
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  await emit({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask])] }, mode: 'history', status: active })
  await emit({ type: 'queue', submissions: [{ id: 'codex-q', clientUserMessageId: 'pending-input',
    input: [{ type: 'text', text: 'queued text' }] }] })
  assert.equal(history.activeTurnId(), 'current')
  assert.equal(history.session.getSnapshot().running, true)
  assert.deepEqual(history.session.projections.faceOf('inbox').getSnapshot(), {
    'next-turn': [{ id: 'codex-q', role: 'user', source: { kind: 'user', rpcId: 'pending-input' },
      content: [{ type: 'text', text: 'queued text' }] }], 'next-step': [],
  })
  await emit({ type: 'change', turn: { id: 'current', status: 'interrupted' }, items: [] })
  assert.equal(history.activeTurnId(), undefined)
  assert.equal(history.session.getSnapshot().running, false)
})

test('取消的原始调用能补入已载入的历史轮次，并随原生回退移除', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const turnId = 'cancelled-turn'
  const input = 'const reply = await tools.exec_command({cmd:"pwd"}); text(reply);'
  const output = 'aborted by user after 8.9s'
  const cancelled = { turnId, id: 'raw-call', name: 'exec', input, output, startedAtMs: 100_016, completedAtMs: 100_025 }
  const laterInTurn = { ...answer, id: 'adapter-comment', completedAtMs: 100_030 }
  await emit({ type: 'snapshot', page: { data: [turn('later', 'completed', [answer]), turn(turnId, 'interrupted', [ask, laterInTurn])] },
    mode: 'history', status: { type: 'idle' } })
  const cancelledFrame = { type: 'rollout-facts', cancelledToolCalls: [cancelled] }
  await emit(cancelledFrame)
  await emit(cancelledFrame)
  const entries = history.events.getSnapshot().entries
  const results = entries.filter(({ event }) => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].event.data.message.content[0].text, output)
  assert.equal(results[0].event.data.message.isError, true)
  const laterEntry = entries.find(({ event }) => event.type === 'assistant/message' && event.data.message.id === laterInTurn.id)
  assert.ok(results[0].event.seq < laterEntry.event.seq)
  const call = entries.find(({ event }) => event.type === 'tool/call').event
  assert.equal(JSON.parse(call.data.arguments).input, input)
  assert.equal(call.data.turn, results[0].event.data.turn)
  await source().onopen()
  assert.equal(history.events.getSnapshot().entries.some(({ event }) => event.type === 'tool/result'), false)
  await emit(cancelledFrame)
  assert.equal(history.events.getSnapshot().entries.some(({ event }) => event.type === 'tool/result'), true)
  await emit({ type: 'rollout-facts', cancelledToolCalls: [] })
  assert.equal(history.events.getSnapshot().entries.some(({ event }) => event.type === 'tool/result'), false)
})

test('实时问题使用原生请求身份，原生确认完成后清理当前投影', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const pending = history.session.projections.faceOf('codexQuestions')
  const emit = requests => source().onmessage({ data: JSON.stringify({ type: 'questions', requests }) })
  const request = { requestId: 41, itemId: 'item-native', isBlocking: true,
    questions: [{ id: 'native-question', question: '选哪个？', options: [{ label: '第一个' }] }],
  }
  assert.equal(source().url.searchParams.get('questions'), '1')
  await emit([request])
  assert.deepEqual(pending.getSnapshot(), [request])
  await emit([])
  assert.deepEqual(pending.getSnapshot(), [])
})

test('查看归档队列可以从 HTTP 补齐投影，但不会覆盖更新的原生队列或归档事件', async t => {
  const source = mockTransport(t)
  const thread = { id: 'archived-thread', archived: true, name: '原生标题', folder: '原生字段' }
  const store = createSnapshotStore({ selected: thread, threads: [thread] })
  const catalog = { store, acceptThread(summary) { store.set({ selected: summary, threads: [summary] }) } }
  const disposers = []
  t.after(() => disposers.reverse().forEach(dispose => dispose()))
  const ctx = { effect(install) { disposers.push(install()) } }
  const history = createCodexHistory(ctx, thread, catalog)
  const input = createSessionInput(ctx, thread.id, history, { getSnapshot: () => undefined })
  await Promise.resolve()
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const archived = value => emit({ type: 'notification', notification: {
    method: value ? 'thread/archived' : 'thread/unarchived', params: { threadId: thread.id },
  } })
  const queued = id => ({ id, input: [{ type: 'text', text: id }], clientUserMessageId: id })
  let response = Promise.withResolvers()
  globalThis.fetch = () => response.promise
  const viewing = input.viewQueue()
  response.resolve(Response.json({ data: [queued('http')] }))
  assert.deepEqual(await viewing, { ok: true, value: { empty: false } })
  assert.equal(history.session.getSnapshot().archived, false)
  assert.deepEqual(store.getSnapshot().threads[0], { ...thread, archived: false })
  assert.equal(history.session.projections.faceOf('inbox').getSnapshot()['next-turn'][0]?.content[0].text, 'http')

  await archived(true)
  catalog.acceptThread(thread)
  response = Promise.withResolvers()
  const stale = input.viewQueue()
  await archived(false)
  await emit({ type: 'queue', submissions: [queued('native')] })
  await archived(true)
  response.resolve(Response.json({ data: [queued('stale')] }))
  assert.deepEqual(await stale, { ok: true, value: { empty: false } })
  assert.equal(history.session.getSnapshot().archived, true)
  assert.equal(store.getSnapshot().threads[0].archived, true)
  assert.equal(history.session.projections.faceOf('inbox').getSnapshot()['next-turn'][0].content[0].text, 'native')
})

test('快速切走再返回会话时，已排入队列的旧审批不会出现在新连接', async t => {
  const source = mockTransport(t)
  const thread = { id: 'thread' }
  const catalog = { store: createSnapshotStore({ selected: thread }) }
  const disposers = []
  t.after(() => disposers.reverse().forEach(dispose => dispose()))
  const history = createCodexHistory({ effect(install) { disposers.push(install()) } }, thread, catalog)
  await Promise.resolve()
  const approvals = history.session.projections.faceOf('codexApprovals')
  const first = source()
  const emit = (from, key) => from.onmessage({ data: JSON.stringify({ type: 'approvals', requests: [{ key }] }) })
  assert.equal(first.url.searchParams.get('questions'), '1')
  await emit(first, 'shown')
  assert.deepEqual(approvals.getSnapshot(), [{ key: 'shown' }])

  const stale = emit(first, 'stale')
  catalog.store.set({ selected: { id: 'different' } })
  const passive = source()
  assert.equal(first.closed, true)
  assert.equal(passive.url.searchParams.has('questions'), false)
  catalog.store.set({ selected: thread })
  assert.equal(passive.closed, true)
  await stale
  assert.deepEqual(approvals.getSnapshot(), [])

  await emit(source(), 'current')
  assert.deepEqual(approvals.getSnapshot(), [{ key: 'current' }])
})

test('异步问答随当前轮次的原生条目弹出，即使没有等待状态或后面还有回复', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const status = { type: 'active', activeFlags: [] }
  const asyncItem = { id: 'ask-options', type: 'agentMessage', phase: 'final_answer', text: '',
    questions: [{ title: 'Choose an environment', options: ['Staging', 'Production'] }, { title: 'Any notes?', options: null }],
  }
  const displayed = () => history.session.projections.faceOf('codexQuestions').getSnapshot()
  await emit({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask])] }, mode: 'live', status })
  assert.deepEqual(displayed(), [])
  await emit({ type: 'change', turn: { id: 'current', status: 'inProgress' }, items: [asyncItem] })
  const [request] = displayed()
  assert.equal(request?.kind, 'async')
  assert.equal(request.turnId, 'current')
  assert.equal(request.itemId, 'ask-options')
  assert.deepEqual(request.questions.map(question => question.id), [
    '["request_user_input_async","ask-options",0]', '["request_user_input_async","ask-options",1]',
  ])
  await emit({ type: 'change', turn: { id: 'current', status: 'completed' }, items: [answer] })
  assert.deepEqual(displayed().map(question => question.itemId), ['ask-options'])
  const text = '<send_user_message_question_reply>{"questionItemId":"[\\"request_user_input_async\\",\\"ask-options\\",0]","question":"Choose an environment","answer":"Staging"}</send_user_message_question_reply>'
  await emit({ type: 'queue', submissions: [{ id: 'pending-answer', input: [{ type: 'text', text }] }] })
  assert.deepEqual(displayed()[0].questions.map(question => question.index), [1])
  await emit({ type: 'change', turn: { id: 'next', status: 'inProgress' }, items: [] })
  assert.deepEqual(displayed(), [])
})

test('stock window appends native tail changes, prepends older history, and keeps both during reconnect', async t => {
  const currentSource = mockTransport(t)
  const received = []
  let dispose
  const reading = []
  const history = createCodexHistory({ effect(callback) { dispose = callback() } }, { id: 'thread' }, {
    setStatus: (...update) => received.push(update),
    setReadState: (...update) => reading.push(update),
    seedReadState: (...update) => reading.push(update),
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

test('实时活动与历史回放共享子智能体状态，重复条目保留原顺序和事件身份', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'root' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const active = { type: 'active', activeFlags: [] }
  const started = { id: 'spawn', type: 'subAgentActivity', kind: 'started', agentPath: '/root/review',
    agentThreadId: 'child', completedAtMs: 100_100 }
  const interrupted = { ...started, id: 'interruption', kind: 'interrupted', completedAtMs: 100_200 }
  const completed = { ...started, id: 'completion', kind: 'completed', agentPath: '/root/reviewer', completedAtMs: 100_300 }
  const activities = () => history.events.getSnapshot().entries.map(({ event }) => event)
    .filter(event => event.type === 'codex/subagent-activity')
  await emit({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask, started])] }, status: active, mode: 'live' })
  assert.deepEqual(activities().map(event => event.data.kind), ['started'])
  await emit({ type: 'change', turn: { id: 'current', status: 'inProgress' }, items: [
    { ...started, id: 'interacted', kind: 'interacted' }, interrupted, completed,
  ] })
  const streamed = activities()
  await emit({ type: 'snapshot', page: { data: [turn('current', 'completed', [
    ask, started, { ...started, id: 'interacted', kind: 'interacted' }, interrupted, completed, answer,
  ])] }, status: { type: 'idle' }, mode: 'live' })
  assert.deepEqual(activities().map(({ time, data }) => [data.kind, data.agentThreadId, data.agentPath, time]), [
    ['started', 'child', '/root/review', 100_100],
    ['interrupted', 'child', '/root/review', 100_200],
    ['completed', 'child', '/root/reviewer', 100_300],
  ])
  assert.strictEqual(activities().at(-1), streamed.at(-1))
  assert.equal(history.events.getSnapshot().entries.some(({ event }) => event.type === 'tool/call'), false)
})

test('从活动打开的未展开子会话仍跟随原生目录更新与删除', async t => {
  const source = mockTransport(t)
  const root = { id: 'root' }
  const parent = { id: 'parent', parentThreadId: root.id }
  const child = { id: 'child', parentThreadId: parent.id }
  const threads = new Map([parent, child].map(thread => [thread.id, thread]))
  globalThis.fetch = async url => {
    if (url.pathname.endsWith('/catalog')) return Response.json({ projects: [], threads: [root], workspacePaths: {}, complete: true })
    if (url.pathname.endsWith('/archived')) return Response.json({ threads: [], workspacePaths: {} })
    assert.equal(url.pathname, '/api/codex/thread-summary')
    const thread = threads.get(url.searchParams.get('threadId'))
    return thread ? Response.json({ thread }) : Response.json({ error: '会话已删除' }, { status: 400 })
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const catalog = createHistoryCatalog(lifetime.signal)
  await new Promise(resolve => {
    const stop = catalog.store.subscribe(() => {
      if (catalog.store.getSnapshot().busy) return
      stop()
      resolve()
    })
  })
  assert.deepEqual(await catalog.resolveSubagent(child.id, lifetime.signal), {
    childSessionId: child.id, parentSessionId: parent.id, mode: 'unknown',
  })
  assert.equal(catalog.store.getSnapshot().childCatalogs[parent.id], undefined)
  const emit = thread => source().onmessage({ data: JSON.stringify({ type: 'thread', id: child.id, thread }) })
  await emit({ ...child, name: '原生会话已改名' })
  assert.equal(catalog.store.getSnapshot().childThreads[child.id].name, '原生会话已改名')
  threads.delete(child.id)
  await emit(null)
  assert.equal(catalog.store.getSnapshot().childThreads[child.id], undefined)
  await assert.rejects(catalog.resolveSubagent(child.id, lifetime.signal), /会话已删除/)
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

test('搜索定位只向前加载未读过的页，保留较新的聊天窗口', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  await emit({ type: 'snapshot', page: { data: [turn('current', 'completed', [answer])], nextCursor: 'older' }, mode: 'live' })
  const original = history.events.getSnapshot().entries.at(-1)
  let reads = 0
  globalThis.fetch = async url => {
    reads++
    assert.equal(url.searchParams.get('cursor'), 'older')
    return Response.json({ data: [turn('older', 'completed', [ask])], nextCursor: null })
  }
  const hit = { turnId: 'older', itemId: ask.id }
  const target = await history.session.findMessage(hit)
  assert.deepEqual(target, { kind: 'input-message', id: ask.id })
  assert.deepEqual(await history.session.findMessage(hit), target)
  assert.equal(reads, 1)
  assert.strictEqual(history.events.getSnapshot().entries.at(-1), original)
  assert.equal(await history.session.findMessage({ turnId: 'older', itemId: 'missing' }), undefined)
})

test('轮次导航摘要与已加载轮次使用同一编号，跳转按原生 ID 补齐旧历史', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  globalThis.fetch = async url => {
    assert.equal(url.searchParams.get('cursor'), 'older')
    return url.pathname.endsWith('/turn-outline')
      ? Response.json([{ id: 'older-turn', prompt: '旧正文预览', response: '' }])
      : Response.json({ data: [turn('older-turn', 'completed', [ask])], nextCursor: null })
  }
  const receive = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  await receive({ type: 'snapshot', page: { data: [turn('current', 'completed', [answer])], nextCursor: 'older' }, mode: 'live', historyMode: 'paginated' })
  assert.equal(history.session.getSnapshot().historyMode, 'paginated')
  const outline = history.session.projections.faceOf('turnOutline')
  const [entry] = outline.getSnapshot() ?? await new Promise(resolve => {
    const stop = outline.subscribe(() => { stop(); resolve(outline.getSnapshot()) })
  })
  assert.equal(entry.prompt, '旧正文预览')
  await history.session.loadThrough(entry.seq)
  const [start] = history.events.getSnapshot().entries
  assert.equal(start.event.data.codexTurnId, 'older-turn')
  assert.equal(start.event.data.turn, entry.turn)
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

test('失败轮次的已读锚点是 DSH 原生错误消息而不是此前的提示词', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const failed = { ...turn('failed', 'failed', [ask]), error: { message: 'native result failure' } }
  const readState = { revision: 'failed-result', firstUnread: { type: 'turn', turnId: 'failed' } }
  await emit({ type: 'snapshot', page: { data: [failed], nextCursor: null }, mode: 'live', readState })
  const end = history.events.getSnapshot().entries.at(-1).event
  assert.deepEqual(history.session.getSnapshot().reading, {
    readState, target: { kind: 'turn-error', id: String(end.data.turn) },
  })
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

test('以问答开头的轮次保留答复定位，后续插话不会成为轮首编辑目标', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const reply = { id: 'qa', type: 'userMessage', content: [{ type: 'text', text:
    '<send_user_message_question_reply>{"questionItemId":"one","question":"Which environment?","answer":"Staging"}</send_user_message_question_reply>' }] }
  const steer = { ...ask, id: 'steer' }
  const page = { data: [turn('reply-turn', 'completed', [reply, steer, answer])], nextCursor: null }
  await currentSource().onmessage({ data: JSON.stringify({ type: 'snapshot', page, mode: 'live' }) })
  const entries = history.events.getSnapshot().entries.map(({ event }) => event)
  const start = entries.find(event => event.type === 'turn/start')
  const inserted = entries.find(event => event.type === 'user/message' && event.data.id === steer.id)
  assert.equal(history.session.editableInput(start.data.turn, inserted.seq), undefined)
  assert.equal(history.session.finishedTurnOfReply(answer.id), 'reply-turn')
  assert.deepEqual(await history.session.findMessage({ turnId: 'reply-turn', itemId: reply.id }), { kind: 'tool-call', id: 'qa' })
})
