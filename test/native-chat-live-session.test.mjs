import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, transformSync } from 'esbuild'
import { projectCodexTurns } from '../src/client/native-chat/events.js'
import { fileAttachmentInput } from '../src/shared/file-attachments.js'

const storeModule = `data:text/javascript,${encodeURIComponent(`
  export function notifySubscribers(listeners) { for (const notify of [...listeners]) notify() }
  export function createSnapshotStore(initial) {
    let value = initial
    const listeners = new Set()
    function set(next) { value = next; for (const notify of listeners) notify() }
    return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, set,
      update(edit) { const next = structuredClone(value); edit(next); set(next) } }
  }
`)}`
const liveWatchModule = `data:text/javascript,${encodeURIComponent(`
  export let openLiveWatch
  export function mockOpenLiveWatch(watch) { openLiveWatch = watch }
`)}`
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-client-store') return { shortCircuit: true, url: storeModule }
    if (specifier === './live-watch.js' || specifier === '../live-watch.js') return { shortCircuit: true, url: liveWatchModule }
    const source = {
      '@deepseek-ai/dsh-client-ui-primitives': `export const Button = null, DisclosureRow = null, IconApiOutlineMedium = null,
        IconQuestionOutlineRegular = null, IconRefreshOutlineRegular = null, InlineEditor = null, Modal = null, Tag = null, Toast = null`,
      react: `export const createElement = (type, props, ...children) => ({ type, props, children });
        export const useState = value => [value, () => {}], useEffect = null, useLayoutEffect = null,
          useMemo = read => read(), useRef = value => ({ current: value }), useSyncExternalStore = null`,
      'react/jsx-runtime': 'export const Fragment = Symbol(), jsx = (type, props) => ({ type, props }), jsxs = jsx',
    }[specifier]
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('.module.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
    const loader = /\.(jsx|tsx|ts)$/.exec(url)?.[1]
    if (!loader) return next(url, context)
    const { code } = transformSync(readFileSync(new URL(url), 'utf8'), { loader, jsx: 'automatic' })
    return { format: 'module', shortCircuit: true, source: code }
  },
})
const { createCodexHistory } = await import('../src/client/native-dsh/session-events.js')
const { createSessionInput } = await import('../src/client/native-dsh/session-input.js')
const { provideCodexControllers } = await import('../src/client/native-dsh/controllers.js')
const { createHistoryCatalog } = await import('../src/client/catalog.js')
const { installPermissions } = await import('../src/client/native-dsh/permissions.js')
const { installComposer } = await import('../src/client/native-dsh/composer.jsx')
const { installCodexQuestions } = await import('../src/client/native-dsh/question-ui.jsx')
const { installCodexMcpSettings } = await import('../src/client/native-dsh/codex-mcp-settings.jsx')
const { SubagentReadOnlyComposer } = await import('@deepseek-ai/dsh-client-ui-subagent/src/client/SubagentReadOnlyComposer.tsx')
const { zh: subagentCopy } = await import('@deepseek-ai/dsh-client-ui-subagent/src/client/locales.ts')
hook.deregister()
const { createSnapshotStore } = await import(storeModule)
const { mockOpenLiveWatch } = await import(liveWatchModule)

function mockTransport(t, sources = []) {
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  globalThis.window = new EventTarget()
  globalThis.document = { baseURI: 'http://127.0.0.1:3190/' }
  mockOpenLiveWatch((threadId, options, lifetime) => {
    sources.push({
      threadId, options,
      get closed() { return lifetime.aborted || undefined },
      onmessage: ({ data }) => options.receive(JSON.parse(data), lifetime),
      onopen: () => options.changeMode?.('connecting', lifetime),
      onerror: () => options.changeMode?.('disconnected', lifetime),
      checkpoint: cursor => options.checkpoint?.(cursor, lifetime),
    })
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    mockOpenLiveWatch(undefined)
    Object.assign(globalThis, original)
  })
  return () => sources.at(-1)
}

function turn(id, status, items) {
  return { id, status, startedAt: 100, items }
}

const ask = { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'native question' }] }
const answer = { id: 'answer', type: 'agentMessage', text: 'native reply' }

test('子会话按原生能力开启输入、插话和继续队列，保留父子地址', async t => {
  const source = mockTransport(t)
  const child = { id: 'child', parentThreadId: 'parent', status: { type: 'idle' },
    source: { subAgent: { thread_spawn: { agent_path: '/root/check' } } } }
  const store = createSnapshotStore({ selected: child, childThreads: { child } })
  const { session } = createCodexHistory({ effect: install => t.after(install()) }, child, { store, setStatus() {} })
  await Promise.resolve()
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const snapshot = fields => emit({ type: 'snapshot', mode: 'live', status: child.status, page: { data: [] }, ...fields })
  const useSession = select => select(session.getSnapshot())
  const useProjection = (key, select) => select(session.projections.faceOf(key).getSnapshot())
  let block
  let continueQueue
  let starts = 0
  const dock = { options: { id: 'queue' }, component() {}, inject() {} }
  const readonly = { locale: 'subagent', component: SubagentReadOnlyComposer }
  const locales = new Map()
  Object.assign(document, { createElement: () => ({ remove() {} }), head: { append() {} } })
  installComposer({
    on: () => () => {},
    slots: { entries: () => [] },
    locale: { bind: name => key => locales.get(name)?.[key], subscribe: () => () => {},
      register: (name, { zh }) => { locales.set(name, zh) } },
    effect: activate => { const dispose = activate(); if (dispose) t.after(dispose) },
    inject(services, install) {
      if (services.includes('uiSession')) install({
        conversation: { blocks: { set: (id, value) => { block = value }, forget() {} } },
        uiSession: { provide: binding => binding.resolve({ sessionId: child.id, session,
          ctx: { effect: activate => t.after(activate()) } }) },
      })
      if (services.length === 1) install({
        slots: { inject: (name, activate) => activate(), register: (options, component) => { continueQueue = component },
          entries: name => [name === 'conversation.composer' ? readonly : dock] },
        effect: activate => t.after(activate()), on: () => () => {},
      })
    },
  })
  const continueButton = () => continueQueue({ useSession, useProjection, t: key => key, startQueue: () => { starts++ } })
  const queueAddress = () => dock.component({ useSession }).props.children[0].props.useSession(state => state.subagent.address)
  const address = () => session.getSnapshot().subagent.address
  function readOnlyNotice() {
    const output = readonly.component({ session: session.getSnapshot(), matched: { reason: 'unknown' }, t: key => subagentCopy[key] })
    const notice = typeof output.type === 'function' ? output.type(output.props) : output
    return notice.props.children.map(element => element.props.children)
  }
  assert.deepEqual(readOnlyNotice(), [subagentCopy['readonly.title'], subagentCopy['readonly.unknown.body']])
  await snapshot({})
  await emit({ type: 'queue', submissions: [{ id: 'queued', input: [{ type: 'text', text: '待发' }] }] })
  assert.equal(block.reason, '此会话无法直接发送消息')
  assert.deepEqual(readOnlyNotice(), ['此子智能体暂时只读', 'Codex 尚未提供此子会话的直接输入能力。'])
  assert.equal(continueButton(), null)
  assert.equal(queueAddress().mode, 'unknown')

  await snapshot({ canAcceptDirectInput: true })
  assert.equal(block, undefined)
  assert.deepEqual(address(), { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' })
  assert.equal(queueAddress().mode, 'continuable')
  await continueButton().props.onClick()
  assert.equal(starts, 1)

  await snapshot({ canAcceptDirectInput: true, status: { type: 'active' }, page: { data: [turn('child-turn', 'inProgress', [ask])] } })
  assert.equal(session.getSnapshot().running, true)
  assert.equal(queueAddress().mode, 'continuable')
  assert.equal(continueButton(), null)

  await snapshot({ canAcceptDirectInput: true, archived: true })
  assert.equal(address().mode, 'continuable')
  assert.equal(queueAddress().mode, 'unknown')
  assert.equal(continueButton().props.children, 'unarchiveAndContinue')

  await snapshot({ canAcceptDirectInput: false, archived: false })
  assert.equal(block.reason, '此会话无法直接发送消息')
  assert.deepEqual(readOnlyNotice(), ['此子智能体为只读', 'Codex 不允许直接向此子智能体发送消息。'])
  assert.equal(queueAddress().mode, 'unknown')
  assert.equal(continueButton(), null)

  // 子代理在 CLI 中加载或卸载时，目录会收到原生状态和最新线程摘要。
  store.update(state => { state.childThreads.child.canAcceptDirectInput = true })
  assert.equal(block, undefined)
  assert.equal(address().mode, 'continuable')
  store.update(state => { state.childThreads.child.canAcceptDirectInput = null })
  assert.equal(block.reason, '此会话无法直接发送消息')
  assert.equal(address().mode, 'unknown')
  assert.deepEqual(readOnlyNotice(), ['此子智能体暂时只读', 'Codex 尚未提供此子会话的直接输入能力。'])
})

test('保存默认模型后，已打开的新会话草稿重读其工作目录的模型', async t => {
  mockTransport(t)
  const cwd = '/workspace/draft'
  let selection = { provider: 'openai', model: 'first', reasoningEffort: 'low' }
  const requests = []
  globalThis.fetch = async url => {
    requests.push([url.pathname, url.searchParams.get('cwd')])
    return Response.json({ default: selection })
  }
  const { session } = createCodexHistory({ effect: install => t.after(install()) },
    { id: 'web-new-draft', cwd, localDraft: true, status: { type: 'idle' } })
  const projected = session.projections.faceOf('modelSelection')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle()
  assert.deepEqual(projected.getSnapshot().next, selection)
  selection = { provider: 'openai', model: 'saved', reasoningEffort: 'high' }
  window.dispatchEvent(new Event('dsh-codex-model-default-changed'))
  await settle()
  assert.deepEqual(projected.getSnapshot().next, selection)
  assert.deepEqual(requests, [['/api/codex/models', cwd], ['/api/codex/models', cwd]])
})

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
  await currentSource().checkpoint('seen-items')
  const binding = await first.ready
  const cached = binding.eventSource.getSnapshot()
  const recent = sessions.retain('first', { source: 'recentViews' })
  const draft = sessions.retain('first', { source: 'draft', connection: false })
  const second = sessions.retain('second', main)
  first.release()
  await Promise.resolve()
  const openThreads = () => sources.filter(source => !source.closed).map(source => source.threadId)
  assert.deepEqual(openThreads(), ['second'])
  assert.strictEqual(recent.binding.eventSource.getSnapshot(), cached)

  const unopenedDraft = sessions.retain('draft', { source: 'draft', connection: false })
  await unopenedDraft.ready
  assert.deepEqual(openThreads(), ['second'])

  const side = sessions.retain('first', { source: 'sidebarChat', facets: { conversation: true } })
  assert.deepEqual(openThreads(), ['second', 'first'])
  assert.equal(currentSource().options.questions, false)
  side.release()
  assert.deepEqual(openThreads(), ['second'])

  const reopened = sessions.retain('first', main)
  second.release()
  assert.deepEqual(openThreads(), ['first'])
  assert.equal(currentSource().options.questions, true)
  assert.equal(currentSource().options.itemCursor, 'seen-items')
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
  const todos = () => session.projections.faceOf('todos').getSnapshot()
  await snapshot('first', 'inProgress')
  assert.equal(session.getSnapshot().running, true)
  assert.equal(current(), undefined)
  await facts('first', work)
  assert.deepEqual(current(), work)
  const plan = [{ content: '核对回归', status: 'in_progress' }]
  await emit({ type: 'rollout-facts', todos: plan })
  await emit({ type: 'rollout-facts', contextPressure: { pressureTokens: 20, contextWindow: 100 } })
  assert.deepEqual(current(), work)
  assert.deepEqual(todos(), plan)
  await emit({ type: 'rollout-facts', todos: null, turnPermission: null })
  assert.equal(current(), undefined)
  assert.equal(todos(), undefined)
  await facts('first', work)
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

test('草稿权限按当前工作目录读取，选择后只写入编辑器草稿', async t => {
  mockTransport(t)
  const owner = new AbortController()
  const id = 'draft-local'
  const catalog = createSnapshotStore({ selected: { id, cwd: '/first', localDraft: true } })
  const list = createSnapshotStore({ byId: {} })
  const generation = createSnapshotStore(0)
  const permissionDraft = { ...createSnapshotStore(undefined), clear() {} }
  const projection = createSnapshotStore({ permission: undefined })
  const session = {
    permissionDraft,
    getSnapshot: () => ({ openState: 'open', localDraft: true, live: { status: { type: 'idle' } } }),
    projections: { faceOf: () => projection },
    publishPermission: permission => projection.set({ permission }),
  }
  const calls = []
  globalThis.fetch = async (url, { method }) => {
    calls.push([method, Object.fromEntries(url.searchParams)])
    return Response.json(method ? { permission: { profileId: ':read-only', source: 'runtime' } }
      : { profiles: [{ id: ':read-only' }] })
  }
  const slot = { locale: 'permission.access', inject: () => ({ hooks: {} }), component: () => null }
  const remote = {}
  const cleanups = []
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    slots: { entries: name => name === 'conversation.input.permission' ? [slot] : [], inject() {} },
    on: () => () => {},
    effect(callback) { cleanups.push(callback()) },
    inject(_keys, callback) { callback(this) },
    connection: { generation },
    get: () => remote,
    sessions: { binding: () => ({ session }), list },
  }
  t.after(() => { owner.abort(); for (const stop of cleanups.reverse()) stop?.() })
  installPermissions(ctx, catalog, owner.signal)
  await new Promise(setImmediate)
  assert.equal(await slot.inject(id).select('read-only'), true)
  assert.equal(permissionDraft.getSnapshot(), ':read-only')
  assert.equal(projection.getSnapshot().permission, undefined)
  list.set({ byId: { [id]: { cwd: '/second' } } })
  await new Promise(setImmediate)
  assert.deepEqual(calls, [[undefined, { cwd: '/first' }], [undefined, { cwd: '/second' }]])
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

test('空闲会话提交后立即回显，队列确认与历史推送之间气泡持续可见', async t => {
  const source = mockTransport(t)
  const ctx = { effect: install => t.after(install()) }
  const history = createCodexHistory(ctx, { id: 'thread' })
  const input = createSessionInput(ctx, 'thread', history, { getSnapshot: () => undefined, clear() {} })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const reply = Promise.withResolvers()
  globalThis.fetch = () => reply.promise
  await emit({ type: 'snapshot', page: { data: [] }, mode: 'live', status: { type: 'idle' } })
  const content = [{ type: 'text', text: '在回答之前显示' }]
  const accepted = t.mock.fn()
  const retired = t.mock.fn()
  const { requestId } = input.beginSubmission({ mode: 'queue', text: content[0].text, attachments: [],
    onAccept: accepted, onRetire: retired })
  const echoes = () => history.session.getSnapshot().pendingSubmissions.map(({ requestId, placement, text }) =>
    [requestId, placement, text])
  const echo = [[requestId, 'transcript', content[0].text]]
  assert.deepEqual(echoes(), echo)
  const sending = input.prompt(content, 'queue', undefined, requestId)
  const queued = { id: 'queued', clientUserMessageId: requestId, input: content }
  await emit({ type: 'queue', submissions: [queued] })
  assert.equal(accepted.mock.callCount(), 1)
  assert.deepEqual(echoes(), echo)

  reply.resolve(Response.json({ queuedSubmission: queued }))
  assert.equal((await sending).ok, true)
  await emit({ type: 'queue', submissions: [] })
  assert.deepEqual(echoes(), echo)
  assert.equal(retired.mock.callCount(), 0)

  await emit({ type: 'change', turn: { id: 'current', status: 'inProgress' },
    items: [{ type: 'userMessage', id: 'sent', clientId: requestId, content }] })
  assert.deepEqual(echoes(), [])
  assert.equal(accepted.mock.callCount(), 1)
  assert.equal(retired.mock.callCount(), 1)
  assert.deepEqual(history.events.getSnapshot().entries.filter(({ event }) => event.type === 'user/message')
    .map(({ event }) => [event.data.source.rpcId, event.data.content]), [[requestId, content]])

  // 另一个客户端已启动轮次，但本页还没有收到活动状态。确认为真正等待的队首要交给队列。
  const waiting = input.beginSubmission({ mode: 'queue', text: content[0].text, attachments: [] })
  const queuedForLater = { ...queued, id: 'waiting', clientUserMessageId: waiting.requestId }
  const waitingReply = Promise.withResolvers()
  globalThis.fetch = () => waitingReply.promise
  const waitingSend = input.prompt(content, 'queue', undefined, waiting.requestId)
  await emit({ type: 'queue', submissions: [queuedForLater] })
  assert.equal(echoes()[0]?.[1], 'transcript')
  waitingReply.resolve(Response.json({ queuedSubmission: queuedForLater, queuedForLater: true }))
  assert.equal((await waitingSend).ok, true)
  assert.deepEqual(echoes(), [])
  assert.equal(history.session.projections.faceOf('inbox').getSnapshot()['next-turn'][0]?.id, queuedForLater.id)
})

function mockDraftPage(t) {
  const source = mockTransport(t)
  const storage = new Map()
  const sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }
  const main = { source: 'mainView', facets: { conversation: true } }
  let view
  let sessions
  let store
  const uiWorkspace = { openSession(id) {
    const next = sessions.retain(id, main)
    view?.release()
    view = next
  } }

  function reload() {
    view?.release()
    view = undefined
    globalThis.window = Object.assign(new EventTarget(), { sessionStorage })
    store = createSnapshotStore({ threads: [], projects: [], workspacePaths: {}, newThreadIds: [], childThreads: {} })
    const catalog = { store, loadChildren() {}, select(thread) { store.update(state => { state.selected = thread }) },
      acceptThread(thread) { store.update(state => { state.threads = [thread] }) } }
    const services = new Map()
    const ctx = { slots: { subscribe() {} }, provide: (key, value) => services.set(key, value), effect: install => t.after(install()),
      inject(services, install) { install({ ...ctx, uiWorkspace }) },
      plugin() {
        const stops = []
        return { ctx: { extend: () => ({ effect: install => stops.push(install()) }) },
          dispose: () => stops.splice(0).reverse().forEach(stop => stop?.()) }
      } }
    provideCodexControllers(ctx, catalog)
    sessions = services.get('sessions')
    return sessions
  }

  t.after(() => view?.release())
  return { source, reload, openSession: uiWorkspace.openSession, view: () => view,
    useCodexHistory: select => select(store.getSnapshot()) }
}

test('Codex MCP 在网页草稿中使用全局配置，原生会话可读取自己的连接状态', async t => {
  const page = mockDraftPage(t)
  const sessions = page.reload()
  let settings
  installCodexMcpSettings({
    effect() {}, locale: { bind: () => key => key },
    slots: {
      inject: (_name, register) => register(),
      register({ name }, component) { if (name === 'settings.section') settings = component },
    },
  })
  const threadId = () => settings({ useCodexHistory: page.useCodexHistory }).props.threadId
  assert.equal(threadId(), undefined)
  const cwd = '/workspace'
  page.openSession(await sessions.create({ cwd }))
  assert.equal(threadId(), undefined)

  const native = { id: '01984de2-8f74-7c91-a3b2-5c5e937cf318', cwd, status: { type: 'idle' } }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ thread: native }))
  assert.equal((await page.view().binding.session.prompt([{ type: 'text', text: '首条消息' }], 'queue')).ok, true)
  t.mock.timers.tick(0)
  assert.equal(threadId(), native.id)
})

test('首发回执丢失后刷新，重试沿用提交身份并把气泡交给原生历史', async t => {
  const page = mockDraftPage(t)
  const sessions = page.reload()
  const native = { id: 'native', cwd: '/workspace', status: { type: 'idle' } }
  const createFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('新建空会话无需 Host 请求') })
  const id = await sessions.create({ cwd: native.cwd })
  assert.match(id, /^web-new-/)
  assert.equal(createFetch.mock.callCount(), 0)
  assert.notEqual(await sessions.create({ cwd: '/different-workspace' }), id)
  assert.equal(await sessions.create({ cwd: native.cwd }), id)
  page.openSession(id)
  const content = [{ type: 'text', text: '这是新会话的首条消息' }]
  const submitted = []
  globalThis.fetch = async (url, request) => {
    if (url.pathname !== '/api/codex/conversation-action') return Response.json({})
    submitted.push(JSON.parse(request.body))
    throw new TypeError('首发 HTTP 回执丢失')
  }
  assert.equal((await page.view().binding.session.prompt(content, 'queue')).ok, false)

  assert.equal(await page.reload().create({ cwd: native.cwd }), id)
  page.openSession(id)
  const draft = page.view().binding.session
  const reply = Promise.withResolvers()
  globalThis.fetch = (url, request) => {
    if (url.pathname !== '/api/codex/conversation-action') return Response.json({})
    submitted.push(JSON.parse(request.body))
    return reply.promise
  }
  const accepted = t.mock.fn()
  const retired = t.mock.fn()
  const { requestId } = draft.beginSubmission({ mode: 'queue', text: content[0].text, attachments: [],
    onAccept: accepted, onRetire: retired })
  const sending = draft.prompt(content, 'queue', undefined, requestId)
  assert.equal(submitted.length, 2)
  assert.equal(submitted[0].threadId, submitted[1].threadId)
  assert.equal(submitted[0].clientUserMessageId, submitted[1].clientUserMessageId)
  assert.equal(draft.getSnapshot().pendingSubmissions[0]?.text, content[0].text)
  // 恢复丢失的首发回执时，历史仍保留最早提交的 ID。
  const nativeRequestId = 'original-attempt'
  reply.resolve(Response.json({ thread: native, clientUserMessageId: nativeRequestId }))
  assert.equal((await sending).ok, true)
  t.mock.timers.tick(0)
  const view = page.view()
  assert.equal(view.sessionId, native.id)
  assert.deepEqual(view.binding.session.getSnapshot().pendingSubmissions.map(item => item.requestId), [nativeRequestId])
  assert.equal(accepted.mock.callCount(), 1)
  assert.equal(retired.mock.callCount(), 0)

  const emit = frame => page.source().onmessage({ data: JSON.stringify(frame) })
  await emit({ type: 'snapshot', page: { data: [] }, mode: 'live', status: { type: 'idle' } })
  assert.equal(view.binding.session.getSnapshot().pendingSubmissions[0]?.text, content[0].text)
  await emit({ type: 'change', turn: { id: 'first', status: 'inProgress' },
    items: [{ type: 'userMessage', id: 'sent', clientId: nativeRequestId, content }] })
  assert.deepEqual(view.binding.session.getSnapshot().pendingSubmissions, [])
  assert.equal(retired.mock.callCount(), 1)
})

test('空会话审查刷新后重试原提交，收到回执后才开启下一次审查', async t => {
  const page = mockDraftPage(t)
  const workspace = { cwd: '/workspace' }
  const submitted = []
  const native = { id: 'review-native', ...workspace, status: { type: 'idle' } }
  globalThis.fetch = async (url, request) => {
    if (url.pathname !== '/api/codex/command-action') return Response.json({})
    submitted.push(JSON.parse(request.body))
    if (submitted.length === 1) throw new TypeError('审查 HTTP 回执丢失')
    return Response.json({ thread: native })
  }
  const id = await page.reload().create(workspace)
  const command = { action: 'review', target: { type: 'uncommittedChanges' } }
  const review = () => page.view().binding.session.runCommand(command)
  page.openSession(id)
  await assert.rejects(review, /审查 HTTP 回执丢失/)

  assert.equal(await page.reload().create(workspace), id)
  page.openSession(id)
  assert.equal((await review()).thread.id, native.id)
  assert.deepEqual(submitted[0], submitted[1])
  assert.notEqual(submitted[1].clientUserMessageId, id, '审查与输入栏首发使用独立标识')
  t.mock.timers.tick(0)
  assert.equal(page.view().sessionId, native.id)

  assert.equal(await page.reload().create(workspace), id, '审查保留输入栏草稿')
  page.openSession(id)
  await review()
  assert.equal(submitted[2].threadId, id)
  assert.notEqual(submitted[2].clientUserMessageId, submitted[1].clientUserMessageId)
})

test('忙碌会话立即显示排队和插话，插话短暂入队后仍保留聊天气泡', async t => {
  const source = mockTransport(t)
  const ctx = { effect: install => t.after(install()) }
  const history = createCodexHistory(ctx, { id: 'busy' })
  const input = createSessionInput(ctx, 'busy', history, { getSnapshot: () => undefined, clear() {} })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const content = [{ type: 'text', text: '补充内容' }]
  const snapshot = () => history.session.getSnapshot().pendingSubmissions
  const status = { type: 'active', activeFlags: [] }
  await emit({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask])] }, mode: 'live', status })
  const queued = input.beginSubmission({ mode: 'queue', text: content[0].text, attachments: [] })
  assert.equal(snapshot()[0]?.placement, 'queued')
  queued.abandon()

  const reply = Promise.withResolvers()
  globalThis.fetch = () => reply.promise
  const { requestId } = input.beginSubmission({ mode: 'steer', text: content[0].text, attachments: [] })
  assert.equal(snapshot()[0]?.placement, 'steering')
  const sending = input.prompt(content, 'steer', undefined, requestId)
  await emit({ type: 'queue', submissions: [{ id: 'fallback', clientUserMessageId: requestId, input: content }] })
  await emit({ type: 'queue', submissions: [] })
  reply.resolve(Response.json({}))
  assert.equal((await sending).ok, true)
  assert.equal(snapshot()[0]?.requestId, requestId)
  await emit({ type: 'change', turn: { id: 'next', status: 'inProgress' },
    items: [{ type: 'userMessage', id: 'steered', clientId: requestId, content }] })
  assert.deepEqual(snapshot(), [])
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
  const delivered = { type: 'userMessage', id: 'delivered', clientId: item.clientUserMessageId, content: item.input }
  await emitter({ type: 'change', turn: { id: 'current', status: 'inProgress' }, items: [delivered] })
  const message = history.events.getSnapshot().entries.find(({ event }) =>
    event.type === 'user/message' && event.data.id === delivered.id)
  assert.deepEqual(message.event.data.content.find(part => part.type === 'file')?.attachment, {
    ...file, downloadUrl: 'api/codex/file-download?' + new URLSearchParams({
      threadId: 'thread', turnId: 'current', itemId: delivered.id, attachmentId: file.attachmentId, name: file.name,
    }),
  })
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

test('目录增量保留其他轮次的文件引用，删除与重连清除旧目录', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const text = '[文件](src/main.js)'
  const first = turn('first', 'completed', [{ ...answer, id: 'first-link', text }])
  const second = turn('second', 'completed', [{ ...answer, id: 'second-link', text }])
  const reply = id => history.events.getSnapshot().entries.find(({ event }) =>
    event.type === 'assistant/message' && event.data.message.id === `${id}-link`).event.data.message.content[0].text
  const directories = turnWorkingDirectories => emit({ type: 'rollout-facts', turnWorkingDirectories })
  await emit({ type: 'snapshot', page: { data: [second, first] }, mode: 'live' })
  await directories({ first: '/old' })
  await directories({ second: '/new' })
  assert.equal(reply('first'), '[文件](/old/src/main.js)')
  assert.equal(reply('second'), '[文件](/new/src/main.js)')

  await directories({ second: null })
  assert.equal(reply('first'), '[文件](/old/src/main.js)')
  assert.equal(reply('second'), text)
  await source().onopen()
  assert.equal(reply('first'), text)
})

test('初始化清理补录时投影失败，下次连接仍移除失效事件', async t => {
  const source = mockTransport(t)
  const { events } = createCodexHistory({ effect: activate => t.after(activate()) }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const round = turn('current', 'inProgress', [ask])
  const call = { turnId: round.id, id: 'cancelled', name: 'exec', input: 'pwd', output: 'aborted by user', completedAtMs: 100_020 }
  await emit({ type: 'snapshot', page: { data: [round] }, mode: 'live' })
  await emit({ type: 'rollout-facts', cancelledToolCalls: [call] })
  const hasCancelled = () => events.getSnapshot().entries.some(({ event }) => event.type === 'tool/result'
    && event.data.message.content[0].text === call.output)
  assert.equal(hasCancelled(), true)

  const stringify = JSON.stringify
  let failOnce = true
  t.mock.method(JSON, 'stringify', (value, ...options) => {
    if (failOnce && value?.event?.type === 'turn/start') {
      failOnce = false
      throw new Error('轮次投影失败')
    }
    return stringify(value, ...options)
  })
  assert.equal(await source().onopen(), false)
  assert.equal(hasCancelled(), true)
  await source().onopen()
  assert.equal(hasCancelled(), false)
})

test('实时问题使用原生请求身份，原生确认完成后清理当前投影', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const pending = history.session.projections.faceOf('codexQuestions')
  const emit = requests => source().onmessage({ data: JSON.stringify({ type: 'questions', requests }) })
  const request = { requestId: 41, itemId: 'item-native', isBlocking: true,
    questions: [{ id: 'native-question', question: '选哪个？', options: [{ label: '第一个' }] }],
  }
  assert.equal(source().options.questions, true)
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
  assert.equal(first.options.questions, true)
  await emit(first, 'shown')
  assert.deepEqual(approvals.getSnapshot(), [{ key: 'shown' }])

  const stale = emit(first, 'stale')
  catalog.store.set({ selected: { id: 'different' } })
  const passive = source()
  assert.equal(first.closed, true)
  assert.equal(passive.options.questions, false)
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

test('问答面板提交后立即显示答案，原生异步历史接手，实时答复保留遮罩', async t => {
  const source = mockTransport(t)
  const ctx = { effect: install => t.after(install()) }
  const history = createCodexHistory(ctx, { id: 'questions' })
  const input = createSessionInput(ctx, 'questions', history, { getSnapshot: () => undefined, clear() {} })
  const session = { ...history.session, ...input }
  const remote = { answer() {} }
  const slots = { inject() {}, entries: () => [] }
  installCodexQuestions({ ...ctx, slots, locale: { register() {}, bind: () => key => key },
    inject(services, install) {
      if (services.includes('remote.userQuestions')) install({ ...ctx, slots, on: () => () => {},
        get: () => remote, sessions: { binding: () => ({ session }) } })
    } })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const asyncItem = { id: 'async', type: 'agentMessage', questions: [{ title: '部署到哪里？', options: ['测试环境'] }] }
  const status = { type: 'active', activeFlags: ['waitingOnUserInput'] }
  await emit({ type: 'snapshot', page: { data: [turn('current', 'inProgress', [ask, asyncItem])] }, mode: 'live', status })
  const echoes = () => session.getSnapshot().pendingSubmissions
  let request
  let url
  let response = Promise.withResolvers()
  globalThis.fetch = (target, options) => {
    url = target.pathname
    request = JSON.parse(options.body)
    return response.promise
  }

  const asyncId = '["request_user_input_async","async",0]'
  const sending = remote.answer('questions', asyncItem.id, { answers: [{ id: asyncId, selected: ['测试环境'] }] })
  assert.equal(url, '/api/codex/async-question-answer')
  assert.equal(echoes()[0]?.text, '部署到哪里？\n测试环境')
  assert.equal(echoes()[0]?.placement, 'steering')
  assert.equal(request.clientUserMessageId, echoes()[0]?.requestId)
  const reply = { questionItemId: asyncId, question: '部署到哪里？', answer: '测试环境' }
  const content = [{ type: 'text', text: `<send_user_message_question_reply>${JSON.stringify([reply])}</send_user_message_question_reply>` }]
  const queued = { id: 'briefly-queued', clientUserMessageId: request.clientUserMessageId, input: content }
  await emit({ type: 'queue', submissions: [queued] })
  assert.equal(echoes().length, 1)
  response.resolve(Response.json({ submitted: true }))
  assert.equal((await sending).ok, true)
  assert.equal(echoes().length, 1)
  await emit({ type: 'change', turn: { id: 'current', status: 'inProgress' },
    items: [{ type: 'userMessage', id: 'saved-answer', clientId: request.clientUserMessageId, content }] })
  // 历史先接手时应立即停用聊天回显，同时仍用其 ID 隐藏队列里迟到的旧行。
  assert.deepEqual(echoes().filter(item => item.placement !== 'queued'), [])
  await emit({ type: 'queue', submissions: [] })
  assert.deepEqual(echoes(), [])
  const answers = () => history.events.getSnapshot().entries.filter(({ event }) => event.type === 'tool/result' && event.data.meta?.codexQuestionReply)
  assert.equal(answers().length, 1)

  await emit({ type: 'questions', requests: [{ requestId: 1, itemId: 'native', turnId: 'current',
    questions: [{ id: 'token', question: '输入令牌', isSecret: true }] }] })
  response = Promise.withResolvers()
  const submitted = { answers: [{ id: 'token', selected: [], custom: 'private-value' }] }
  const rejected = remote.answer('questions', 'native', submitted)
  assert.equal(url, '/api/codex/question-answer')
  assert.equal(echoes()[0]?.text, '输入令牌\nsecretAnswer')
  assert.deepEqual(request.answers, { token: { answers: ['user_note: private-value'] } })
  response.resolve(Response.json({ error: '原生请求失败' }, { status: 503 }))
  await assert.rejects(rejected, /原生请求失败/)
  assert.deepEqual(echoes(), [])
  assert.equal(answers().length, 1)

  response = Promise.withResolvers()
  // 实时应答有可能先于对应轮次的历史增量到达。
  await emit({ type: 'questions', requests: [{ requestId: 2, itemId: 'native', turnId: 'not-yet-saved',
    questions: [{ id: 'token', question: '输入令牌', isSecret: true }] }] })
  const retry = remote.answer('questions', 'native', submitted)
  response.resolve(Response.json({ submitted: true }))
  assert.equal((await retry).ok, true)
  assert.equal(echoes()[0]?.text, '输入令牌\nsecretAnswer')
  await emit({ type: 'change', turn: { id: 'not-yet-saved', status: 'inProgress' }, items: [{ ...ask, id: 'new-ask' }] })
  assert.deepEqual(echoes(), [])
  const confirmed = history.events.getSnapshot().entries.filter(({ event }) => event.type === 'user/message'
    && event.data.source.kind === 'user-question-reply')
  assert.equal(confirmed.length, 1)
  assert.equal(JSON.parse(confirmed[0].event.data.content[0].text).answers[0].custom, 'secretAnswer')
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
  assert.equal(source.threadId, 'thread')

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

test('长轮次逐条接收工具结果时只转换新增条目', async t => {
  const source = mockTransport(t)
  const stringify = JSON.stringify
  let projected = 0
  let compared = 0
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.auditToolOrdinal !== undefined) projected++
    if (value?.type === 'event') compared++
    return stringify(value, ...args)
  })

  const measurements = []
  const cases = [100, 200, 400].map(count => ({ count, withCancellation: false }))
  cases.push({ count: 400, withCancellation: true }, { count: 400, withCancellation: true, untimed: true })
  for (const { count, withCancellation, untimed = false } of cases) {
    const { events } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' })
    const emit = frame => source().onmessage({ data: stringify(frame) })
    const head = turn('head', 'inProgress', [ask])
    const older = turn('older', 'completed', [{ ...answer, id: 'earlier-answer' }])
    await emit({ type: 'snapshot', page: { data: [head, older], nextCursor: null }, mode: 'live' })
    const facts = { type: 'rollout-facts', cancelledToolCalls: [{ turnId: head.id, id: 'cancelled', name: 'exec',
      input: 'pwd', output: 'aborted by user', completedAtMs: 100_020 }] }
    if (withCancellation) await emit(facts)
    const initial = events.getSnapshot()
    projected = 0
    compared = 0
    for (let index = 0; index < count; index++) {
      if (withCancellation && index === 10) await emit(facts)
      await emit({ type: 'change', turn: { id: head.id }, items: [{
        type: 'dynamicToolCall', id: `tool-${index}`, status: 'completed', tool: 'test-tool',
        arguments: { auditToolOrdinal: index }, output: `output-${index}`,
        ...(withCancellation && !untimed && { completedAtMs: 100_030 + index }),
      }] })
    }
    const current = events.getSnapshot()
    assert.equal(current.change.kind, 'append')
    assert.equal(initial.entries.at(-1).event.type, withCancellation ? 'tool/result' : 'user/message')
    assert.deepEqual(current.change.entries.map(entry => entry.event.type), ['tool/call', 'tool/result'])
    assert.strictEqual(current.entries[initial.entries.length - 1], initial.entries.at(-1))
    assert.equal(current.entries.length, initial.entries.length + count * 2)
    assert.strictEqual(current.entries[0], initial.entries[0])
    assert.equal(current.entries.at(-1).event.data.message.content[0].text, `output-${count - 1}`)
    measurements.push({ count, withCancellation, untimed, projected, compared })
  }
  t.diagnostic(JSON.stringify(measurements))
  for (const { count, projected, compared } of measurements) {
    assert.equal(projected, count, '原生工具参数只在首次转换该条目时序列化')
    assert.equal(compared, 0, '纯追加不需要序列化历史事件来比较内容')
  }
})

test('取消补录后的无时间戳条目增量进入实际 DSH 组装器', async t => {
  const root = '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation'
  const assembly = fileURLToPath(import.meta.resolve(`${root}/assembly.ts`))
  const assembler = fileURLToPath(import.meta.resolve(`${root}/assembler.ts`))
  // 加载依赖包的原生组装器和绑定，复用测试的快照 Store，无需启动浏览器。
  const { outputFiles } = await build({
    stdin: { contents: `export { UiConversation } from ${JSON.stringify(assembly)};
      export { ConversationNodeAssembler } from ${JSON.stringify(assembler)};
      export { Context } from '@deepseek-ai/cordis'`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'snapshot-store', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-store$/ }, () => ({ path: storeModule, external: true }))
    } }],
  })
  const { Context, UiConversation, ConversationNodeAssembler } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
  const source = mockTransport(t)
  const { replaceWindow, append } = ConversationNodeAssembler.prototype
  let replayed = 0
  let appended = 0
  t.mock.method(ConversationNodeAssembler.prototype, 'replaceWindow', function(entries, hasMore) {
    replayed += entries.length
    return replaceWindow.call(this, entries, hasMore)
  })
  t.mock.method(ConversationNodeAssembler.prototype, 'append', function(entry) {
    appended++
    return append.call(this, entry)
  })

  const measurements = []
  for (const timed of [false, true]) {
    for (const count of [100, 200, 400]) {
      const ctx = new Context()
      const sessionId = 'thread'
      const { events } = createCodexHistory({ effect: install => t.after(install()) }, { id: sessionId })
      const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
      const head = turn('current', 'inProgress', [ask])
      const cancelled = { turnId: head.id, id: 'cancelled', name: 'exec', input: 'pwd', output: 'aborted by user', completedAtMs: 100_020 }
      await emit({ type: 'snapshot', page: { data: [head] }, mode: 'live' })
      await emit({ type: 'rollout-facts', cancelledToolCalls: [cancelled] })
      const initial = events.getSnapshot().entries
      const owner = { ctx, sessionId, eventSource: events }
      const retained = createSnapshotStore({ retainedFacets: { conversation: 1 } })
      t.after(() => retained.set({}))
      const conversation = new UiConversation(ctx, { binding: () => owner, retainInfo: () => retained })
      const binding = conversation.binding(sessionId)
      assert.equal(binding.openTurn.getSnapshot(), initial[0].event.data.turn)
      replayed = 0
      appended = 0
      for (let index = 0; index < count; index++) {
        await emit({ type: 'change', turn: { id: head.id }, items: [{ id: `tool-${index}`, type: 'dynamicToolCall',
          status: 'completed', output: `${index}`, ...(timed && { completedAtMs: 100_030 + index }) }] })
      }
      measurements.push({ timed, count, replayed, appended })
    }
  }
  t.diagnostic(JSON.stringify(measurements))
  for (const { timed, count, replayed, appended } of measurements) {
    assert.equal(replayed, 0, `${count} 条工具结果（时间戳 ${timed}）无需重放已加载窗口`)
    assert.equal(appended, count * 2)
  }
})

test('取消补录随条目时间移动，并在同 ID 的原生命令到达时合并', async t => {
  const source = mockTransport(t)
  const { events } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const turnId = 'active'
  const cancelled = { turnId, id: 'early', name: 'exec', input: 'pwd', output: 'aborted by user', completedAtMs: 100_020 }
  const unchanged = { ...cancelled, id: 'unchanged', completedAtMs: 100_010 }
  const trailing = { ...cancelled, id: 'late', completedAtMs: 100_080 }
  const anchor = { id: 'anchor', type: 'dynamicToolCall', status: 'completed', output: 'anchor',
    arguments: { auditAnchor: true }, completedAtMs: 100_050 }
  const untimed = { id: 'untimed', type: 'dynamicToolCall', status: 'completed', output: 'untimed' }
  const snapshot = () => events.getSnapshot()
  const results = () => snapshot().entries.filter(({ event }) => event.type === 'tool/result')
  const ids = () => results().map(({ event }) => event.data.message.id)
  const change = item => emit({ type: 'change', turn: { id: turnId }, items: [item] })
  await emit({ type: 'snapshot', page: { data: [turn(turnId, 'inProgress', [ask, anchor])] }, mode: 'live' })
  await emit({ type: 'rollout-facts', cancelledToolCalls: [trailing, cancelled, unchanged] })
  assert.deepEqual(ids(), ['codex:cancelled:unchanged', 'codex:cancelled:early', 'anchor', 'codex:cancelled:late'])
  const [, early, anchored, late] = results()

  await change(untimed)
  assert.equal(snapshot().change.kind, 'append')
  assert.deepEqual(ids(), ['codex:cancelled:unchanged', 'codex:cancelled:early', 'anchor', 'codex:cancelled:late', 'untimed'])
  assert.strictEqual(results()[1], early)
  assert.strictEqual(results()[2], anchored)
  assert.strictEqual(results()[3], late)
  const first = snapshot().entries[0].event
  assert.deepEqual(snapshot().entries, projectCodexTurns([turn(turnId, 'inProgress', [ask, anchor, untimed])], {
    firstSeq: first.seq, beforeTurn: first.data.turn + 1,
    cancelledToolCalls: new Map([[turnId, [trailing, cancelled, unchanged]]]),
  }))

  const command = { id: cancelled.id, type: 'commandExecution', command: 'pwd', status: 'inProgress', aggregatedOutput: '/workspace' }
  await change(command)
  assert.deepEqual(ids(), ['codex:cancelled:unchanged', 'anchor', 'untimed', 'early', 'codex:cancelled:late'])
  assert.match(results()[3].event.data.message.content[0].text, /\/workspace\naborted by user/)

  await change({ ...command, status: 'completed', completedAtMs: 100_100, exitCode: 0 })
  assert.deepEqual(ids(), ['codex:cancelled:unchanged', 'anchor', 'untimed', 'codex:cancelled:late', 'early'])
  assert.equal(results().at(-1).event.data.message.content[0].text, '/workspace\n[exit code: 0]')

  let anchorProjections = 0
  const stringify = JSON.stringify
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.auditAnchor) anchorProjections++
    return stringify(value, ...args)
  })
  await change({ ...command, id: trailing.id })
  assert.equal(anchorProjections, 0, '轮尾补录合并时保留前面的工具结果')
  assert.deepEqual(ids(), ['codex:cancelled:unchanged', 'anchor', 'untimed', 'early', 'late'])

  await emit({ type: 'rollout-facts', cancelledToolCalls: [] })
  assert.deepEqual(ids(), ['anchor', 'untimed', 'early'])
  await change({ ...anchor, id: 'after-clear', completedAtMs: 100_150 })
  assert.equal(snapshot().change.kind, 'append')
  assert.deepEqual(ids(), ['anchor', 'untimed', 'early', 'after-clear'])
})

test('增量改写时间、目标提示和压缩完成后的事件与整轮回放一致', async t => {
  const source = mockTransport(t)
  const { events } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' })
  const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
  const id = 'active-turn'
  const compaction = { id: 'compaction', type: 'contextCompaction' }
  const command = { id: 'cmd', type: 'commandExecution', command: 'pwd', status: 'inProgress', startedAtMs: 120_000 }
  const goalInputs = { [id]: { objective: '构建报告', time: 99_999 } }
  const goal = { ...ask, id: 'goal-message', content: [{ type: 'text', text: '/goal 构建报告' }] }
  const change = (items, metadata) => emit({ type: 'change', turn: { id, ...metadata }, items })
  await emit({ type: 'snapshot', mode: 'live', page: { data: [{ id, status: 'inProgress', items: [ask] }] } })
  const first = events.getSnapshot().entries[0].event
  function assertReplay(items, metadata) {
    const expected = projectCodexTurns([{ id, status: 'inProgress', items, ...metadata }], {
      firstSeq: first.seq, beforeTurn: first.data.turn + 1, goalInputs,
    })
    assert.deepEqual(events.getSnapshot().entries, expected)
  }
  await emit({ type: 'rollout-facts', goalInputs })
  await change([compaction, command])
  assertReplay([ask, compaction, command])

  const completed = { ...command, status: 'completed', completedAtMs: 121_000, exitCode: 0, aggregatedOutput: '/work' }
  await change([completed, goal, answer])
  assertReplay([ask, compaction, completed, goal, answer])
  const corrected = { ...answer, text: '修订后的回复' }
  await change([corrected])
  assertReplay([ask, compaction, completed, goal, corrected])

  const end = { status: 'completed', completedAt: 130 }
  await change([], end)
  assertReplay([ask, compaction, completed, goal, corrected], end)
  assert.equal(events.getSnapshot().change.kind, 'replace')
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
    childSessionId: child.id, parentSessionId: parent.id, mode: 'continuable',
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

test('实时流重连与补读历史期间持续提示，收到快照后恢复', async t => {
  const currentSource = mockTransport(t)
  let historyRequests = 0
  const first = turn('first', 'completed', [ask])
  globalThis.fetch = async url => {
    assert.equal(url.pathname, '/api/codex/turns')
    historyRequests++
    return Response.json({ data: [first], nextCursor: null })
  }
  const history = createCodexHistory({ effect: activate => t.after(activate()) }, { id: 'thread' })
  const source = currentSource()
  await source.onerror()
  await source.onerror()
  await history.ready
  assert.equal(historyRequests, 1)
  assert.equal(history.session.getSnapshot().openState, 'open')
  assert.equal(history.session.getSnapshot().live.reconnecting, true)
  assert.ok(history.events.getSnapshot().entries.some(entry => entry.event.type === 'user/message'))

  await source.onopen()
  assert.equal(history.session.getSnapshot().live.reconnecting, true)
  await source.onmessage({ data: JSON.stringify({ type: 'snapshot', mode: 'live', page: { data: [first] } }) })
  assert.equal(history.session.getSnapshot().live.reconnecting, false)
})

test('历史投影失败时通知传输，随后仍能恢复会话', async t => {
  const source = mockTransport(t)
  const history = createCodexHistory({ effect: activate => t.after(activate()) }, { id: 'thread' })
  const snapshot = page => source().onmessage({ data: JSON.stringify({ type: 'snapshot', page, mode: 'live' }) })

  assert.equal(await snapshot(null), false)
  assert.equal(history.session.getSnapshot().openState, 'error')
  await snapshot({ data: [turn('first', 'completed', [ask])] })
  assert.equal(history.session.getSnapshot().openState, 'open')
  assert.ok(history.events.getSnapshot().entries.some(({ event }) => event.type === 'user/message'))
})

for (const type of ['snapshot', 'change']) {
  test(`${type} 合并后投影失败，重放相同记录仍能生成事件`, async t => {
    const source = mockTransport(t)
    const history = createCodexHistory({ effect: activate => t.after(activate()) }, { id: 'thread' })
    const emit = frame => source().onmessage({ data: JSON.stringify(frame) })
    const command = { id: 'cmd', type: 'commandExecution', command: 'echo ready', status: 'completed' }
    const round = turn('first', 'inProgress', [ask])
    const snapshot = items => ({ type: 'snapshot', mode: 'live', page: { data: [{ ...round, items }] } })
    if (type === 'change') await emit(snapshot([ask]))
    const frame = type === 'snapshot' ? snapshot([ask, command]) : { type, turn: { id: round.id }, items: [command] }

    const stringify = JSON.stringify
    let failOnce = true
    t.mock.method(JSON, 'stringify', (value, ...options) => {
      if (failOnce && value?.description === command.command) {
        failOnce = false
        throw new Error('工具投影失败')
      }
      return stringify(value, ...options)
    })
    assert.equal(await emit(frame), false)
    assert.equal(history.events.getSnapshot().entries.some(({ event }) => event.data.callId === command.id), false)
    await emit(frame)
    assert.ok(history.events.getSnapshot().entries.some(({ event }) => event.data.callId === command.id))
  })
}

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

test('打开与重连分页会话时只使用尾页', async t => {
  const currentSource = mockTransport(t)
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const requested = []
  globalThis.fetch = async url => {
    requested.push(url.pathname)
    return Response.json([])
  }
  const receive = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const current = turn('current', 'completed', [answer])
  const snapshot = { type: 'snapshot', page: { data: [current], nextCursor: 'older' }, mode: 'live', historyMode: 'paginated' }
  await receive(snapshot)
  await receive({ ...snapshot, page: { ...snapshot.page, data: [turn('new', 'completed', []), current] } })
  assert.equal(history.session.getSnapshot().historyMode, 'paginated')
  assert.equal(history.session.getSnapshot().hasMore, true)
  assert.deepEqual(requested, [])
})

test('原生加载更早暂存一页，聊天消费后才插入旧轮次', async t => {
  const currentSource = mockTransport(t)
  const { session, events } = createCodexHistory({ effect() {} }, { id: 'thread' })
  const receive = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const tail = turn('current', 'completed', [answer])
  await receive({ type: 'snapshot', page: { data: [tail], nextCursor: 'older' }, mode: 'live' })
  const original = events.getSnapshot()
  const cursors = []
  const reply = Promise.withResolvers()
  globalThis.fetch = async url => {
    assert.equal(url.pathname, '/api/codex/turns')
    const cursor = url.searchParams.get('cursor')
    cursors.push(cursor)
    return cursor === 'older' ? reply.promise : Response.json({ data: [turn('oldest', 'completed', [])], nextCursor: null })
  }

  const older = session.loadOlder({ deferConsumption: true })
  const duplicate = session.loadOlder({ deferConsumption: true })
  assert.equal(session.getSnapshot().loadingOlder, true)
  reply.resolve(Response.json({ data: [turn('older', 'completed', [ask])], nextCursor: 'oldest' }))
  await Promise.all([older, duplicate])
  assert.equal(session.getSnapshot().historyLoadStatus, 'pendingConsumption')
  assert.strictEqual(events.getSnapshot(), original)
  assert.deepEqual(cursors, ['older'])

  assert.equal(session.consumeOlder(), true)
  assert.equal(session.consumeOlder(), false)
  const expanded = events.getSnapshot()
  assert.equal(expanded.change.kind, 'prepend')
  assert.equal(expanded.entries[0].event.data.codexTurnId, 'older')
  assert.strictEqual(expanded.entries.at(-1), original.entries.at(-1))
  assert.equal(session.getSnapshot().historyLoadStatus, 'idle')

  await session.loadOlder({ deferConsumption: true })
  assert.equal(session.consumeOlder(), true)
  assert.deepEqual(cursors, ['older', 'oldest'])
  assert.equal(session.getSnapshot().hasMore, false)
  assert.equal(session.getSnapshot().historyWasPartial, true)
})

test('切走时取消未完成的旧页，最近会话缓存可从同一游标重新加载', async t => {
  const currentSource = mockTransport(t)
  const retention = createSnapshotStore({ connectionCount: 1 })
  const { session, events } = createCodexHistory({ effect: install => t.after(install()) }, { id: 'thread' }, undefined, retention)
  await Promise.resolve()
  const snapshot = { type: 'snapshot', page: { data: [turn('current', 'completed', [answer])], nextCursor: 'older' }, mode: 'live' }
  const receive = () => currentSource().onmessage({ data: JSON.stringify(snapshot) })
  await receive()
  const original = events.getSnapshot()
  const started = Promise.withResolvers()
  const stale = Promise.withResolvers()
  globalThis.fetch = (_, { signal }) => {
    started.resolve(signal)
    return stale.promise
  }
  const oldRequest = session.loadOlder({ deferConsumption: true })
  const requestSignal = await started.promise
  retention.set({})
  assert.equal(requestSignal.aborted, true)
  assert.strictEqual(events.getSnapshot(), original)

  retention.set({ connectionCount: 1 })
  await receive()
  globalThis.fetch = async url => {
    assert.equal(url.searchParams.get('cursor'), 'older')
    return Response.json({ data: [turn('fresh', 'completed', [ask])], nextCursor: null })
  }
  await session.loadOlder({ deferConsumption: true })
  stale.resolve(Response.json({ data: [turn('stale', 'completed', [])], nextCursor: null }))
  await oldRequest
  assert.equal(session.consumeOlder(), true)
  assert.equal(events.getSnapshot().entries[0].event.data.codexTurnId, 'fresh')
})

test('回退替换历史窗口时取消旧页，再从新游标读取', async t => {
  const currentSource = mockTransport(t)
  const { session, events } = createCodexHistory({ effect() {} }, { id: 'thread' })
  const source = currentSource()
  const snapshot = (id, nextCursor, replace = false) => source.onmessage({ data: JSON.stringify({
    type: 'snapshot', page: { data: [turn(id, 'completed', [answer])], nextCursor }, mode: 'live', replace,
  }) })
  await snapshot('before-revert', 'old-cursor')

  const started = Promise.withResolvers()
  const stale = Promise.withResolvers()
  const cursors = []
  globalThis.fetch = async (url, { signal }) => {
    const cursor = url.searchParams.get('cursor')
    cursors.push(cursor)
    if (cursor === 'old-cursor') {
      started.resolve(signal)
      return stale.promise
    }
    return Response.json({ data: [turn('earlier', 'completed', [ask])], nextCursor: null })
  }

  const oldRequest = session.loadOlder({ deferConsumption: true })
  const oldSignal = await started.promise
  await snapshot('after-revert', 'new-cursor', true)
  assert.equal(oldSignal.aborted, true)
  assert.equal(source.closed, undefined)
  assert.equal(session.getSnapshot().historyLoadStatus, 'idle')
  await session.loadOlder({ deferConsumption: true })
  stale.resolve(Response.json({ data: [turn('stale', 'completed', [])], nextCursor: null }))
  await oldRequest

  assert.deepEqual(cursors, ['old-cursor', 'new-cursor'])
  assert.equal(session.consumeOlder(), true)
  assert.deepEqual(events.getSnapshot().entries.filter(({ event }) => event.type === 'turn/start')
    .map(({ event }) => event.data.codexTurnId), ['earlier', 'after-revert'])
})

test('旧页读取失败时保持会话打开，并可重试原游标', async t => {
  const currentSource = mockTransport(t)
  const { session, events } = createCodexHistory({ effect() {} }, { id: 'thread' })
  await currentSource().onmessage({ data: JSON.stringify({
    type: 'snapshot', page: { data: [turn('current', 'completed', [answer])], nextCursor: 'older' }, mode: 'live',
  }) })
  const original = events.getSnapshot()
  const cursors = []
  globalThis.fetch = async url => {
    cursors.push(url.searchParams.get('cursor'))
    return cursors.length === 1 ? Response.json({ error: '原生历史读取失败' }, { status: 503 })
      : Response.json({ data: [turn('older', 'completed', [ask])], nextCursor: null })
  }
  await session.loadOlder({ deferConsumption: true })
  assert.equal(session.getSnapshot().openState, 'open')
  assert.equal(session.getSnapshot().historyLoadStatus, 'error')
  assert.strictEqual(events.getSnapshot(), original)
  await session.loadOlder({ deferConsumption: true })
  assert.equal(session.consumeOlder(), true)
  assert.deepEqual(cursors, ['older', 'older'])
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

test('重连快照移除回退轮次和对应图片，保留已有轮次的附件', async t => {
  const currentSource = mockTransport(t)
  const originalImage = globalThis.Image
  t.after(() => { globalThis.Image = originalImage })
  globalThis.Image = class {
    naturalWidth = 1
    naturalHeight = 1
    decode() {}
  }
  const history = createCodexHistory({ effect() {} }, { id: 'thread' })
  const emit = frame => currentSource().onmessage({ data: JSON.stringify(frame) })
  const image = id => ({ id, type: 'userMessage', content: [{ type: 'image', url: 'data:image/png;base64,AA==' }] })
  const older = turn('earlier', 'completed', [image('keep-image')])
  const removed = turn('removed', 'completed', [image('old-image'), answer])
  const snapshot = data => emit({ type: 'snapshot', page: { data, nextCursor: null }, mode: 'live' })
  await snapshot([removed, older])
  const references = Object.fromEntries(history.events.getSnapshot().entries.filter(({ event }) => event.type === 'user/message')
    .map(({ event }) => [event.data.id, event.data.content[0].attachment]))
  const read = id => history.session.readAttachment(references[id])
  assert.deepEqual((await read('old-image')).value.data, new Uint8Array([0]))
  const previous = history.events.getSnapshot().entries[0]
  await snapshot([older])
  const current = history.events.getSnapshot()
  assert.equal(current.change.kind, 'replace')
  assert.strictEqual(current.entries[0], previous)
  assert.equal(current.entries.some(entry => entry.event.data.codexTurnId === 'removed'), false)
  assert.equal((await read('old-image')).ok, false)
  assert.deepEqual((await read('keep-image')).value.data, new Uint8Array([0]))
  await snapshot([])
  assert.deepEqual(history.events.getSnapshot().entries, [])
  assert.equal(history.session.getSnapshot().live.lastTurnStatus, undefined)
  assert.equal((await read('keep-image')).ok, false)
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

test('目录加载完成时保留用户先打开的全局面板', t => {
  const opened = []
  const services = new Map()
  const store = createSnapshotStore({ busy: true, threads: [{ id: 'existing', cwd: '/workspace' }],
    projects: [], workspacePaths: {}, newThreadIds: [], childThreads: {} })
  const ctx = {
    provide: (id, value) => services.set(id, value),
    slots: { subscribe() {} },
    effect(install) { const stop = install(); if (stop) t.after(stop) },
    inject(_services, install) { install(this) },
    uiWorkspace: { openSession: id => opened.push(id) },
    layout: { panelInfo: createSnapshotStore({ activePanelId: 'settings' }) },
  }
  provideCodexControllers(ctx, { store })
  store.update(state => { state.busy = false })
  assert.deepEqual(opened, [])
  assert.equal(services.get('sessions').list.getSnapshot().phase, 'ready')
})
