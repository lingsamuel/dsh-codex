import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileAttachmentInput } from '../src/shared/file-attachments.js'

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
      const url = 'data:text/javascript,export const Toast = null; export const createElement = (type, props, ...children) => ({ type, props, children })'
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

function mockTransport(t, sources = []) {
  const original = { window: globalThis.window, document: globalThis.document, EventSource: globalThis.EventSource, fetch: globalThis.fetch }
  globalThis.window = new EventTarget()
  globalThis.document = { baseURI: 'http://127.0.0.1:3190/' }
  globalThis.EventSource = class extends EventTarget {
    constructor(url) { super(); this.url = url; sources.push(this) }
    close() { this.closed = true }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => Object.assign(globalThis, original))
  return () => sources.at(-1)
}

function turn(id, status, items) {
  return { id, status, startedAt: 100, items }
}

const ask = { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'native question' }] }
const answer = { id: 'answer', type: 'agentMessage', text: 'native reply' }

test('最近会话和草稿只保留缓存，视图重开时续读原生历史', async t => {
  const sources = []
  mockTransport(t, sources)
  const currentSource = () => sources.findLast(source => !source.closed)
  const threads = ['first', 'second', 'draft'].map(id => ({ id, cwd: '/workspace' }))
  const store = createSnapshotStore({ threads, projects: [], workspacePaths: {}, newThreadIds: [], childThreads: {} })
  const catalog = { store, loadChildren() {}, select(thread) { store.update(state => { state.selected = thread }) } }
  const services = new Map()
  const disposers = []
  t.after(() => disposers.reverse().forEach(dispose => dispose?.()))
  provideCodexControllers({
    slots: { subscribe() {} },
    provide: (key, value) => services.set(key, value),
    effect: install => disposers.push(install()),
    inject() {},
    plugin() {
      const stops = []
      const dispose = () => stops.splice(0).reverse().forEach(stop => stop())
      disposers.push(dispose)
      return { ctx: { extend: () => ({ effect: install => stops.push(install()) }) }, dispose }
    },
  }, catalog)
  const sessions = services.get('sessions')
  const main = { source: 'mainView', facets: { conversation: true } }
  const nativeTurn = turn('initial', 'completed', [ask, answer])
  const emit = async (...turns) => currentSource().onmessage({ data: JSON.stringify({ type: 'snapshot', page: { data: turns }, mode: 'live' }) })

  const first = sessions.retain('first', main)
  await Promise.resolve()
  await emit(nativeTurn)
  currentSource().dispatchEvent(new MessageEvent('history-checkpoint', { lastEventId: 'seen-items' }))
  const binding = await first.ready
  const cached = binding.eventSource.getSnapshot()
  const recent = sessions.retain('first', { source: 'recentViews' })
  const draft = sessions.retain('first', { source: 'draft', connection: false })
  const second = sessions.retain('second', main)
  first.release()
  await Promise.resolve()
  const openThreads = () => sources.filter(source => !source.closed).map(source => source.url.searchParams.get('threadId'))
  assert.deepEqual(openThreads(), ['second'])
  assert.strictEqual(recent.binding.eventSource.getSnapshot(), cached)

  const unopenedDraft = sessions.retain('draft', { source: 'draft', connection: false })
  await unopenedDraft.ready
  assert.deepEqual(openThreads(), ['second'])

  const side = sessions.retain('first', { source: 'sidebarChat', facets: { conversation: true } })
  assert.deepEqual(openThreads(), ['second', 'first'])
  assert.equal(currentSource().url.searchParams.has('questions'), false)
  side.release()
  assert.deepEqual(openThreads(), ['second'])

  const reopened = sessions.retain('first', main)
  second.release()
  assert.deepEqual(openThreads(), ['first'])
  assert.equal(currentSource().url.searchParams.get('questions'), '1')
  assert.equal(currentSource().url.searchParams.get('itemCursor'), 'seen-items')
  assert.strictEqual(reopened.binding, binding)
  await emit(turn('while-away', 'completed', [{ ...ask, id: 'new-ask' }]), nativeTurn)
  assert.ok(binding.eventSource.getSnapshot().entries.some(({ event }) => event.data.codexTurnId === 'while-away'))

  reopened.release()
  recent.release()
  draft.release()
  unopenedDraft.release()
  assert.deepEqual(openThreads(), [])
})

test('切走会话时取消重连补页，不把已暂停的缓存重新标为实时', async t => {
  const source = mockTransport(t)
  const retention = createSnapshotStore({ connectionCount: 1 })
  const history = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' }, undefined, retention)
  await Promise.resolve()
  const emit = (data, nextCursor) => source().onmessage({ data: JSON.stringify({
    type: 'snapshot', mode: 'live', page: { data, nextCursor },
  }) })
  const initial = turn('initial', 'completed', [ask])
  await emit([initial])

  const request = Promise.withResolvers()
  const reply = Promise.withResolvers()
  globalThis.fetch = (_, { signal }) => {
    request.resolve(signal)
    return reply.promise
  }
  const refresh = emit([turn('new', 'completed', [answer])], 'gap')
  const requestSignal = await request.promise
  retention.set({})
  reply.resolve(Response.json({ data: [initial] }))
  await refresh

  assert.equal(requestSignal.aborted, true)
  assert.equal(history.session.getSnapshot().live.mode, 'disconnected')
  assert.deepEqual(history.events.getSnapshot().entries.filter(({ event }) => event.type === 'turn/start')
    .map(({ event }) => event.data.codexTurnId), ['initial'])
})

test('命令结果不会覆盖期间收到的较新计划模式与目标通知', async t => {
  const source = mockTransport(t)
  const disposers = []
  const { session } = createCodexHistory({ effect(install) { disposers.push(install()) } }, { id: 'thread' })
  t.after(() => { for (const dispose of disposers.reverse()) dispose?.() })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  await emit({ type: 'rollout-facts', planMode: 'default' })
  const { planRevision, goalRevision } = session.getSnapshot()
  await emit({ type: 'notification', notification: { method: 'thread/settings/updated', params: {
    threadId: 'thread', threadSettings: { collaborationMode: { mode: 'plan' } },
  } } })
  await emit({ type: 'notification', notification: { method: 'thread/goal/cleared', params: { threadId: 'thread' } } })
  await emit({ type: 'rollout-facts', planMode: 'default' })
  session.publishPlanMode('default', planRevision)
  session.publishGoal({ status: 'active', objective: 'old' }, goalRevision)
  assert.equal(session.getSnapshot().planMode, 'plan')
  assert.equal(session.getSnapshot().goal, null)
  session.publishPlanMode('default', session.getSnapshot().planRevision)
  assert.equal(session.getSnapshot().planMode, 'default')

  session.publishPlanMode('plan')
  await source().onopen()
  await emit({ type: 'rollout-facts', planMode: 'default' })
  assert.equal(session.getSnapshot().planMode, 'default')
})

test('实时快照恢复 GoalBar 和 Plan 模式，目标气泡随历史补齐', async t => {
  const source = mockTransport(t)
  const { session, events } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const goal = { objective: '构建报告', status: 'active', createdAt: 100 }
  const snapshot = { type: 'snapshot', mode: 'live', status: { type: 'active' },
    page: { data: [turn('goal-turn', 'inProgress', [answer])] }, goal, planMode: 'plan' }
  await source().onopen()
  await emit(snapshot)
  assert.equal(session.projections.faceOf('goal').getSnapshot()?.goal.phase, 'active')
  assert.deepEqual(session.projections.faceOf('plan').getSnapshot(), { active: true, pending: false })

  await emit({ type: 'rollout-facts', goalInputs: { 'goal-turn': { objective: goal.objective, time: 99_999 } } })
  assert.equal(events.getSnapshot().entries.find(({ event }) => event.type === 'user/message')?.event.data.content[0].text,
    '/goal 构建报告')
  await source().onopen()
  session.publishGoal(null)
  await emit(snapshot)
  assert.equal(session.projections.faceOf('goal').getSnapshot(), null)
})

test('保留计划的原生条目身份和正文，供聊天及侧栏共用', async t => {
  const source = mockTransport(t)
  const { session } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' })
  const item = { type: 'plan', id: 'plan-item', text: '# 计划\n\n- 核对结果。' }
  await source().onmessage({ data: JSON.stringify({ type: 'snapshot', mode: 'live',
    page: { data: [turn('plan-turn', 'completed', [item, answer])] },
  }) })
  assert.equal(session.planMarkdown('plan-turn', item.id), item.text)
  assert.equal(session.planMarkdown('plan-turn', answer.id), undefined)
  assert.equal(await session.readPlanMarkdown('plan-turn', item.id), item.text)
  assert.equal(await session.readPlanMarkdown('unknown', item.id), undefined)
})

test('活动轮次显示自己的权限，切换后续权限和重新连接按轮次核对', async t => {
  const source = mockTransport(t)
  const { session } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const snapshot = (id, status) => emit({ type: 'snapshot', mode: 'live',
    status: { type: status === 'inProgress' ? 'active' : 'idle' },
    page: { data: [turn(id, status, [ask])] },
  })
  const facts = (turnId, permission) => emit({ type: 'rollout-facts', turnPermission: { turnId, permission } })
  const work = { profileId: ':workspace', source: 'saved' }
  const readOnly = { profileId: ':read-only', source: 'saved' }
  const current = () => session.getSnapshot().live.turnPermission
  const selected = () => session.projections.faceOf('permissions').getSnapshot().permission
  await snapshot('first', 'inProgress')
  assert.equal(session.getSnapshot().running, true)
  assert.equal(current(), undefined)
  await facts('first', work)
  assert.deepEqual(current(), work)
  session.publishPermission(readOnly)
  assert.deepEqual(selected(), readOnly)
  assert.deepEqual(current(), work)

  await source().onopen()
  await snapshot('first', 'inProgress')
  assert.equal(current(), undefined)
  await facts('first', work)
  assert.deepEqual(current(), work)

  await snapshot('second', 'inProgress')
  assert.equal(current(), undefined)
  await facts('first', work)
  assert.equal(current(), undefined)
  await facts('second', readOnly)
  assert.deepEqual(current(), readOnly)
  await snapshot('second', 'completed')
  assert.equal(current(), undefined)
})

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

test('运行中有正文且下轮权限有变化时才提示插话范围', async t => {
  mockTransport(t)
  const owner = new AbortController()
  const catalog = createSnapshotStore({ selected: { id: 'thread' } })
  const generation = createSnapshotStore(0)
  const draft = { ...createSnapshotStore(undefined), clear() {} }
  const work = { profileId: ':workspace', sandbox: 'workspace-write', approvalPolicy: 'on-request', source: 'saved' }
  const state = { openState: 'open', running: true, live: { status: { type: 'active' }, turnPermission: work } }
  const input = { phase: 'plain', draft: '' }
  const unchanged = { permission: { ...work, sandbox: 'workspaceWrite', source: 'runtime' } }
  const projection = createSnapshotStore(unchanged)
  const session = { permissionDraft: draft, getSnapshot: () => state, projections: { faceOf: () => projection },
    publishPermission: permission => projection.set({ permission }) }
  const calls = []
  const readOnly = { profileId: ':read-only', source: 'runtime' }
  globalThis.fetch = async (url, request) => {
    if (!request.method) return Response.json({ profiles: [{ id: ':read-only' }] })
    calls.push([url.pathname, JSON.parse(request.body)])
    return Response.json({ permission: readOnly })
  }
  const Native = () => null
  const slot = { locale: 'permission.access', component: Native, inject: () => ({ hooks: {} }) }
  const cleanups = []
  const remote = {}
  let labels
  const ctx = {
    locale: {
      bind: () => (key, args = {}) => (labels?.[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => args[name]),
      register(_, copy) { labels = copy.zh },
    },
    slots: { entries: name => name === 'conversation.input.permission' ? [slot] : [], inject() {} },
    on: () => () => {},
    effect(callback) { cleanups.push(callback()) },
    inject(_keys, callback) { callback(this) },
    connection: { generation }, get: () => remote, sessions: { binding: id => id === 'thread' ? { session } : undefined },
  }
  t.after(() => { owner.abort(); for (const stop of cleanups.reverse()) stop?.() })
  installPermissions(ctx, catalog, owner.signal)
  await new Promise(setImmediate)

  const provided = slot.inject('thread')
  const render = () => slot.component({ ...provided, useProjection: () => projection.getSnapshot(), useSession: use => use(state),
    useInput: use => use(input), usePermissionDraft: use => use(draft.getSnapshot()),
    usePermissionCatalog: use => use(provided.hooks.permissionCatalog.getSnapshot()), t: key => key })
  const hint = () => render().children.find(child => child?.children?.includes('新权限从下一轮生效，插话沿用本轮权限'))
  const native = render().children.find(child => child?.type === Native)
  assert.equal(native?.props.t('mode', { name: '仅可查看' }), '下轮权限 · 仅可查看')

  assert.equal(hint(), undefined)
  input.draft = '补充要求'
  assert.equal(hint(), undefined)
  assert.equal(await provided.select('read-only'), true)
  assert.deepEqual(calls, [['/api/codex/permission-action', { action: 'select', threadId: 'thread', profileId: ':read-only' }]])
  assert.deepEqual(projection.getSnapshot().permission, readOnly)
  assert.equal(hint()?.props.title, '本轮权限 · 工作区内修改 · 沙箱：工作区内修改 · 审批：按需')
  input.draft = ' \n '
  assert.equal(hint(), undefined)
  input.draft = '补充要求'
  input.phase = 'sending'
  assert.equal(hint(), undefined)
  input.phase = 'plain'
  projection.set(unchanged)
  assert.equal(hint(), undefined)
  projection.set({ permission: readOnly })
  state.live.turnPermission = undefined
  assert.equal(hint(), undefined)
  state.live.turnPermission = work
  state.running = false
  assert.equal(hint(), undefined)
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

test('待发插话副本保留在队列区域，不参与再次插话或编辑器草稿提交', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const model = { getSnapshot: () => undefined }
  const input = createSessionInput({ effect() {} }, 'thread', history, model)
  const originalImage = globalThis.Image
  t.after(() => { globalThis.Image = originalImage })
  globalThis.Image = class {
    naturalWidth = 1
    naturalHeight = 1
    decode() {}
  }
  const requests = []
  const reply = Promise.withResolvers()
  const image = 'data:image/png;base64,AA=='
  globalThis.fetch = (url, options) => {
    if (url === image) return new Response(new Uint8Array([0]), { headers: { 'Content-Type': 'image/png' } })
    requests.push(JSON.parse(options.body))
    return reply.promise
  }
  const emitter = frame => source().onmessage({ data: JSON.stringify(frame) })
  const file = { attachmentId: 'sha256:' + 'a'.repeat(64), name: '报告.txt', bytes: 4 }
  const item = { id: 'queued', clientUserMessageId: 'client-id', input: [
    { type: 'text', text: 'A' }, { type: 'image', url: image }, fileAttachmentInput(file, '/stored/报告.txt'),
  ] }
  const other = { id: 'other', clientUserMessageId: 'other-id', input: [{ type: 'text', text: '其他待发项' }] }
  const active = { type: 'active', activeFlags: [] }
  await emitter({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask])] }, mode: 'history', status: active })
  await emitter({ type: 'queue', submissions: [item, other] })
  const sending = input.updateQueue(item.id, { kind: 'steer' })
  assert.deepEqual(requests, [{ action: 'queue', threadId: 'thread', queuedSubmissionId: item.id, operation: 'steer', expectedTurnId: 'current' }])

  await emitter({ type: 'queue', submissions: [other], steers: [{ item, status: 'steering' }] })
  const inbox = history.session.projections.faceOf('inbox')
  const pending = inbox.getSnapshot().queuedSteers[0]
  assert.equal(pending.placement, 'queued')
  assert.equal(pending.text, 'A')
  assert.equal(pending.attachments[0].value.previewUrl, image)
  assert.deepEqual(pending.attachments[1], {
    type: 'file', value: { ...file, downloadUrl: 'api/codex/file-download?' + new URLSearchParams({
      threadId: 'thread', queuedSubmissionId: item.id, attachmentId: file.attachmentId, name: file.name,
    }) },
  })
  assert.deepEqual(inbox.getSnapshot()['next-turn'].map(row => row.id), [other.id])
  assert.deepEqual(history.session.getSnapshot().pendingSubmissions, [])
  reply.resolve(Response.json({ error: '断线', reason: 'queue-steer-unknown' }, { status: 409 }))
  assert.equal((await sending).ok, false)
  await emitter({ type: 'queue', submissions: [other], steers: [{ item, status: 'unconfirmed' }] })
  assert.equal(inbox.getSnapshot().queuedSteers[0].status, 'unconfirmed')
  await emitter({ type: 'queue', submissions: [other] })
  assert.equal(inbox.getSnapshot().queuedSteers, undefined)
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

test('归档会话接收队列投影时保留会话和目录的归档状态', async t => {
  const source = mockTransport(t)
  const thread = { id: 'archived-thread', archived: true, name: '原生标题', folder: '原生字段' }
  const store = createSnapshotStore({ selected: thread, threads: [thread] })
  const catalog = { store, acceptThread(summary) { store.set({ selected: summary, threads: [summary] }) } }
  const disposers = []
  t.after(() => disposers.reverse().forEach(dispose => dispose()))
  const ctx = { effect(install) { disposers.push(install()) } }
  const history = createCodexHistory(ctx, thread, catalog)
  await Promise.resolve()
  const emitQueue = submissions => source().onmessage({ data: JSON.stringify({ type: 'queue', submissions }) })
  const inbox = history.session.projections.faceOf('inbox')
  await emitQueue([{ id: 'queued', clientUserMessageId: 'client', input: [{ type: 'text', text: '待发内容' }] }])
  assert.equal(inbox.getSnapshot()['next-turn'][0].content[0].text, '待发内容')
  await emitQueue([])
  assert.deepEqual(inbox.getSnapshot()['next-turn'], [])
  assert.equal(history.session.getSnapshot().archived, true)
  assert.deepEqual(store.getSnapshot().threads[0], thread)
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
  const asyncItem = { id: 'ask-options', type: 'agentMessage', phase: 'final_answer', delivery: 'async',
    text: 'Choose an environment\n- Staging\n- Production\n\nAny notes?',
    questions: [{ title: 'Choose an environment', options: ['Staging', 'Production'] }, { title: 'Any notes?', options: null }],
  }
  const displayed = () => history.session.projections.faceOf('codexQuestions').getSnapshot()
  await emit({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask])] }, mode: 'live', status })
  assert.deepEqual(displayed(), [])
  await emit({ type: 'change', turn: { id: 'current', status: 'inProgress' }, items: [asyncItem] })
  const transcript = history.events.getSnapshot().entries.map(({ event }) => event)
    .filter(event => event.type === 'assistant/message')
  assert.deepEqual(transcript.map(({ data }) => data.message.content), [[{ type: 'text', text: asyncItem.text }]])
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
  const queued = { id: 'pending-answer', input: [{ type: 'text', text }] }
  await emit({ type: 'queue', submissions: [queued] })
  assert.deepEqual(displayed()[0].questions.map(question => question.index), [1])
  await emit({ type: 'queue', submissions: [], steers: [{ item: queued, status: 'unconfirmed' }] })
  assert.deepEqual(displayed()[0].questions.map(question => question.index), [1])
  await emit({ type: 'change', turn: { id: 'next', status: 'inProgress' }, items: [] })
  assert.deepEqual(displayed(), [])
})

test('归档会话从只读历史同时显示异步问题正文与原生问答面板', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'archived', archived: true })
  const question = { id: 'archived-question', type: 'agentMessage', delivery: 'async', text: '',
    questions: [{ title: '部署到哪里？', options: ['测试环境', '正式环境'] }] }
  await source().onmessage({ data: JSON.stringify({ type: 'snapshot', archived: true,
    page: { data: [turn('saved-question', 'completed', [ask, question])] }, mode: 'history', status: { type: 'notLoaded' },
  }) })
  const reply = history.events.getSnapshot().entries.find(({ event }) => event.type === 'assistant/message')
  assert.equal(reply.event.data.message.content[0].text, '**部署到哪里？**\n\n- 测试环境\n- 正式环境')
  const [pending] = history.session.projections.faceOf('userQuestions').getSnapshot().active
  assert.equal(pending.callId, question.id)
  assert.deepEqual(pending.questions[0].options.map(option => option.label), question.questions[0].options)
  assert.equal(history.session.getSnapshot().archived, true)
  assert.deepEqual(history.session.getSnapshot().live.status, { type: 'notLoaded' })
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

test('项目归属通知早于归档清单时保留归档状态，显式取消归档仍生效', async t => {
  const source = mockTransport(t)
  const archived = Promise.withResolvers()
  const thread = { id: 'archive', cwd: '/workspace', name: 'Archive' }
  globalThis.fetch = async url => {
    if (url.pathname.endsWith('/archived')) return archived.promise
    return Response.json({ projects: [], threads: [], workspacePaths: {}, complete: true })
  }
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const catalog = createHistoryCatalog(lifetime.signal)
  const emit = current => source().onmessage({ data: JSON.stringify({ type: 'thread', id: thread.id, thread: current }) })
  const moved = { ...thread, projectId: 'project' }
  await emit(moved)
  archived.resolve(Response.json({ threads: [{ ...thread, archived: true }], workspacePaths: {} }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(catalog.store.getSnapshot().threads[0].archived, true)
  assert.equal(catalog.store.getSnapshot().threads[0].projectId, 'project')
  await emit({ ...moved, archived: false })
  assert.equal(catalog.store.getSnapshot().threads[0].archived, false)
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
