import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionInput } from '../src/client/native-dsh/session-input.js'

test('直接发送 /plan 正文只投递任务，裸命令只切换模式', async t => {
  const requests = []
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    requests.push([url.pathname, body])
    return Response.json(body.action === 'plan' ? { mode: body.mode, confirmed: true } : { planMode: 'plan' })
  })
  const state = { pendingSubmissions: [], planMode: 'default', planRevision: 0, running: true }
  const subscribe = () => () => {}
  const history = {
    session: { getSnapshot: () => state, publishPlanMode(mode) { state.planMode = mode } },
    events: { getSnapshot: () => ({ entries: [] }), subscribe },
    queueStore: { getSnapshot: () => [], subscribe }, updateState: edit => edit(state),
    activeTurnId: () => 'current',
  }
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history,
    { getSnapshot: () => undefined, clear() {} })
  const text = '/plan 整理结果\n说明验证步骤'
  const { requestId } = input.beginSubmission({ mode: 'steer', text, attachments: [] })
  assert.equal(state.pendingSubmissions[0].text, '整理结果\n说明验证步骤')
  assert.equal(state.pendingSubmissions[0].placement, 'queued')
  assert.equal((await input.prompt([{ type: 'text', text }], 'steer', undefined, requestId)).ok, true)
  assert.deepEqual(requests[0], ['/api/codex/conversation-action', { threadId: 'native', action: 'prompt', mode: 'queue',
    planMode: 'plan', clientUserMessageId: requestId, input: [{ type: 'text', text: '整理结果\n说明验证步骤', text_elements: [] }] }])
  assert.equal(state.planMode, 'plan')
  assert.equal((await input.prompt([{ type: 'text', text: '/plan' }], 'queue')).ok, true)
  assert.deepEqual(requests[1], ['/api/codex/command-action', { threadId: 'native', action: 'plan', mode: 'default' }])
  assert.equal(state.planMode, 'default')
})

test('已有会话的普通文件以原生上传回执发送', async t => {
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url.pathname, JSON.parse(options.body)])
    return Response.json({})
  })
  const state = { pendingSubmissions: [] }
  const subscribe = () => () => {}
  const history = {
    session: { getSnapshot: () => state }, events: { getSnapshot: () => ({ entries: [] }), subscribe },
    queueStore: { getSnapshot: () => [], subscribe }, updateState: edit => edit(state),
  }
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history,
    { getSnapshot: () => undefined, clear() {} })
  const file = { type: 'file', receiptId: 'uploaded-receipt' }
  assert.equal((await input.prompt([file], 'queue', undefined, 'request')).ok, true)
  assert.deepEqual(requests, [['/api/codex/conversation-action', {
    threadId: 'native', action: 'prompt', mode: 'queue', clientUserMessageId: 'request', input: [file],
  }]])
  assert.equal(state.promptError, null)
})

test('直接发送完整 /goal 命令在已有会话创建原生目标', async t => {
  const requests = []
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!options?.body) return Response.json({ goal: null })
    requests.push([url.pathname, JSON.parse(options.body)])
    return Response.json({ goal: { objective: '整理结果', status: 'active' } })
  })
  const state = { pendingSubmissions: [] }
  const subscribe = () => () => {}
  const history = {
    session: { getSnapshot: () => state, publishGoal(goal) { state.goal = goal } },
    events: { getSnapshot: () => ({ entries: [] }), subscribe },
    queueStore: { getSnapshot: () => [], subscribe }, updateState: edit => edit(state),
  }
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history,
    { getSnapshot: () => undefined, clear() {} })
  const text = '/goal 整理结果'
  const { requestId } = input.beginSubmission({ mode: 'queue', text, attachments: [] })
  assert.deepEqual(state.pendingSubmissions, [])
  assert.equal((await input.prompt([{ type: 'text', text }], 'queue', undefined, requestId)).ok, true)
  assert.deepEqual(requests, [['/api/codex/command-action', { threadId: 'native', action: 'goal-create', objective: '整理结果' }]])
  assert.equal(state.goal.status, 'active')
})

function newSessionFixture(t, fetchResult, { planMode = 'default', model, profileId, worktree, goal, openWorktree } = {}) {
  const threadId = `draft-${crypto.randomUUID()}`
  const newSession = { cwd: '/repository', projectId: 'project' }
  const state = { localDraft: true, blank: true, planMode, planRevision: 0, pendingSubmissions: [] }
  const requests = []
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    requests.push([url.pathname, JSON.parse(request.body)])
    return fetchResult(request)
  })
  const subscribe = () => () => {}
  const history = {
    session: {
      getSnapshot: () => state,
      publishPlanMode(mode, revision) { if (revision === state.planRevision) state.planMode = mode },
      projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
    },
    events: { getSnapshot: () => ({ entries: [] }), subscribe },
    queueStore: { getSnapshot: () => [], subscribe }, updateState: edit => edit(state),
  }
  function setting(initial) {
    let current = initial
    return { subscribe, getSnapshot: () => current, clear(value) { if (current === value) current = undefined } }
  }
  const modelDraft = setting(model)
  const permissionDraft = setting(profileId)
  const worktreeDraft = setting(worktree)
  const goalDraft = setting(goal)
  const bind = () => createSessionInput({ effect: effect => t.after(effect()) }, threadId, history, modelDraft, permissionDraft,
    worktreeDraft, openWorktree, goalDraft, newSession, () => 'review-request')
  return { bind, state, requests, threadId, newSession, modelDraft, permissionDraft, worktreeDraft, goalDraft }
}

test('空会话的 /plan 本地切换随首次正文和附件发送，原生回执接续回显', async t => {
  const reply = Promise.withResolvers()
  const thread = { id: 'native', cwd: '/different-worktree' }
  const worktree = { kind: 'existing', id: crypto.randomUUID(), path: thread.cwd }
  const model = { provider: 'openai', model: 'selected', reasoningEffort: 'high' }
  const profileId = ':read-only'
  const lifecycle = []
  const fixture = newSessionFixture(t, () => reply.promise, { model, profileId, worktree,
    openWorktree(result, confirmed, handoff) {
      assert.equal(confirmed, true)
      lifecycle.push(result.thread.id)
      handoff({ adoptSubmission(echo, retire) {
        lifecycle.push({ requestId: echo.requestId, text: echo.text, attachments: echo.attachments })
        retire()
      } })
    },
  })
  const { state, requests, threadId, newSession } = fixture
  const input = fixture.bind()
  assert.equal((await input.prompt([{ type: 'text', text: '/plan' }], 'queue')).ok, true)
  assert.deepEqual(requests, [])
  assert.equal(state.planMode, 'plan')

  const text = '开始计划'
  const attachments = [{ type: 'file', value: { name: 'notes.txt' } }]
  const { requestId } = input.beginSubmission({ mode: 'queue', text, attachments,
    onAccept: () => lifecycle.push('accepted'), onRetire: settlement => lifecycle.push(settlement.reason) })
  const sending = input.prompt([{ type: 'file', receiptId: 'uploaded' }, { type: 'text', text }], 'queue', undefined, requestId)
  assert.deepEqual(requests, [['/api/codex/conversation-action', { threadId, action: 'prompt', newSession, mode: 'queue',
    clientUserMessageId: requestId, reportQueuedForLater: true, modelDraft: model, permissionDraft: profileId, planMode: 'plan', worktree,
    input: [{ type: 'file', receiptId: 'uploaded' }, { type: 'text', text, text_elements: [] }] }]])
  assert.deepEqual(lifecycle, [])
  assert.equal(state.pendingSubmissions[0].requestId, requestId)

  reply.resolve(Response.json({ thread, clientUserMessageId: 'original-native-id', planMode: 'plan' }))
  assert.equal((await sending).ok, true)
  assert.deepEqual(lifecycle, ['accepted', thread.id, { requestId: 'original-native-id', text, attachments }, 'observed'])
  assert.deepEqual(state.pendingSubmissions, [])
  assert.equal(fixture.modelDraft.getSnapshot(), undefined)
  assert.equal(fixture.permissionDraft.getSnapshot(), undefined)
  assert.equal(fixture.worktreeDraft.getSnapshot(), undefined)
})

test('取消或拒绝首发时保留输入设置，重试使用原提交身份', async t => {
  const model = { provider: 'openai', model: 'selected' }
  const lifecycle = []
  const fixture = newSessionFixture(t, ({ signal }) => {
    if (fixture.requests.length === 2) return Response.json({ error: 'fixture rejected' }, { status: 409 })
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, { model,
    openWorktree: () => assert.fail('未接纳的输入不能切换会话'),
  })
  const input = fixture.bind()
  function send(text, signal) {
    const { requestId } = input.beginSubmission({ mode: 'queue', text, attachments: [],
      onAccept: () => lifecycle.push('accepted'), onRetire: settlement => lifecycle.push(settlement.reason) })
    return input.prompt([{ type: 'text', text }], 'queue', signal, requestId)
  }
  const controller = new AbortController()
  const cancelled = send('首次输入', controller.signal)
  controller.abort()
  assert.equal((await cancelled).ok, false)
  assert.equal((await send('编辑后重试')).ok, false)
  assert.equal(fixture.requests.length, 2)
  assert.equal(fixture.requests[0][1].clientUserMessageId, fixture.requests[1][1].clientUserMessageId)
  assert.deepEqual(lifecycle, ['failed', 'failed'])
  assert.deepEqual(fixture.state.pendingSubmissions, [])
  assert.deepEqual(fixture.modelDraft.getSnapshot(), model)
})

test('首发内容冲突时保留可打开的原生会话和当前草稿', async t => {
  const recovery = { thread: { id: 'original', cwd: '/repository' }, workspacePaths: {} }
  const lifecycle = []
  const fixture = newSessionFixture(t, () => Response.json({ error: '请打开原生会话核对',
    reason: 'new-session-input-changed', newSessionRecovery: recovery }, { status: 409 }), {
    openWorktree: () => assert.fail('需要用户明确选择是否打开原生会话'),
  })
  const input = fixture.bind()
  const text = '编辑后的消息'
  const { requestId } = input.beginSubmission({ mode: 'queue', text, attachments: [],
    onAccept: () => assert.fail('未发送的编辑不应被清除'), onRetire: settlement => lifecycle.push(settlement.reason) })
  const result = await input.prompt([{ type: 'text', text }], 'queue', undefined, requestId)
  assert.equal(result.error.code, 'session/new-session-input-changed')
  assert.deepEqual(fixture.state.newSessionRecovery, recovery)
  assert.deepEqual(lifecycle, ['failed'])
})

test('空会话明确提交 /goal 时以首次原生操作创建目标和会话', async t => {
  const thread = { id: 'goal-native', cwd: '/repository' }
  const goal = { objective: '整理结果', status: 'active' }
  const worktree = { kind: 'new', id: crypto.randomUUID(), baseRef: 'refs/heads/main' }
  const model = { provider: 'openai', model: 'selected' }
  const profileId = ':read-only'
  const opened = []
  const fixture = newSessionFixture(t, () => Response.json({ thread, goal }), { planMode: 'plan', model, profileId, worktree,
    openWorktree: result => opened.push(result.thread),
  })
  const { threadId, newSession, requests, state } = fixture
  const input = fixture.bind()
  const text = '/goal 整理结果'
  const { requestId } = input.beginSubmission({ mode: 'queue', text, attachments: [] })
  assert.equal((await input.prompt([{ type: 'text', text }], 'queue', undefined, requestId)).ok, true)
  assert.deepEqual(requests, [['/api/codex/command-action', { threadId, action: 'goal-create', newSession, clientUserMessageId: requestId,
    objective: '整理结果', modelDraft: model, permissionDraft: profileId, worktree }]])
  assert.deepEqual(opened, [thread])
  assert.deepEqual(state.pendingSubmissions, [])
})

test('空会话确认审查时提交原生命令，失败保留设置，重试沿用首次提交身份', async t => {
  const thread = { id: 'review-native', cwd: '/repository' }
  const model = { provider: 'openai', model: 'selected' }
  const profileId = ':read-only'
  const worktree = { kind: 'existing', id: crypto.randomUUID(), path: '/worktree' }
  const recovery = { thread, workspacePaths: {} }
  const opened = []
  let fail = true
  const fixture = newSessionFixture(t, () => fail ? Response.json({ error: 'review unconfirmed',
    reason: 'new-session-delivery-unconfirmed', newSessionRecovery: recovery }, { status: 409 })
    : Response.json({ thread }), { planMode: 'plan', model, profileId, worktree,
    openWorktree: (result, confirmed, handoff, keepInput) => opened.push([result.thread, confirmed, keepInput]),
  })
  const { threadId, newSession, requests } = fixture
  const command = { action: 'review', target: { type: 'uncommittedChanges' } }
  const input = fixture.bind()
  await assert.rejects(input.runCommand(command), /review unconfirmed/)
  assert.deepEqual(opened, [])
  assert.deepEqual(fixture.state.newSessionRecovery, recovery)
  assert.deepEqual(fixture.modelDraft.getSnapshot(), model)
  fail = false
  await input.runCommand(command)
  const { clientUserMessageId } = requests[0][1]
  assert.ok(clientUserMessageId)
  const sent = ['/api/codex/command-action', { threadId, newSession, clientUserMessageId, ...command,
    modelDraft: model, permissionDraft: profileId, worktree, planMode: 'plan' }]
  assert.deepEqual(requests, [sent, sent])
  assert.deepEqual(opened, [[thread, true, true]])
  assert.equal(fixture.state.newSessionRecovery, undefined)
  assert.equal(fixture.modelDraft.getSnapshot(), undefined)
  assert.equal(fixture.permissionDraft.getSnapshot(), undefined)
  assert.equal(fixture.worktreeDraft.getSnapshot(), undefined)
})

test('Goal 发送错误归属本次输入模式，退出后图片走普通发送', async t => {
  let draft = { budget: '' }
  let changed
  const goalDraft = { getSnapshot: () => draft,
    subscribe(listener) { changed = listener; return () => {} },
    clear(value) { if (value === draft) { draft = undefined; changed() } },
  }
  const requests = []
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url.pathname, JSON.parse(options.body)])
    return Response.json({ queuedSubmissionId: 'image' })
  })
  const state = { pendingSubmissions: [] }
  const subscribe = () => () => {}
  const history = {
    session: { getSnapshot: () => state }, events: { getSnapshot: () => ({ entries: [] }), subscribe },
    queueStore: { getSnapshot: () => [], subscribe }, updateState: edit => edit(state),
  }
  const model = { getSnapshot: () => undefined, clear() {} }
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history, model, undefined, undefined, undefined, goalDraft)
  const image = [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]
  assert.equal((await input.prompt(image, 'queue')).ok, false)
  assert.match(state.goalError.message, /退出 Goal 模式/)
  assert.equal(state.promptError, null)
  assert.deepEqual(requests, [])

  goalDraft.clear(goalDraft.getSnapshot())
  assert.equal(state.goalError, null)
  assert.equal((await input.prompt(image, 'queue')).ok, true)
  assert.equal(goalDraft.getSnapshot(), undefined)
  assert.equal(state.promptError, null)
  assert.equal(requests.length, 1)
  assert.equal(requests[0][0], '/api/codex/conversation-action')
  assert.deepEqual(requests[0][1].input, [{ type: 'image', url: 'data:image/png;base64,AAAA' }])
})

test('输入栏创建目标需确认替换，取消保留 Goal 模式，成功只提交原生目标', async t => {
  const existing = { objective: '旧目标', status: 'paused', createdAt: 100 }
  const next = { objective: '新目标', status: 'active', createdAt: 100 }
  const state = { pendingSubmissions: [], goal: existing, goalRevision: 0 }
  let draft = { budget: '250' }
  const requests = []
  let confirmationReady
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!options?.body) return Response.json({ goal: existing })
    requests.push([url.pathname, JSON.parse(options.body)])
    return Response.json({ goal: next })
  })
  const noopSubscribe = () => () => {}
  const history = {
    session: { getSnapshot: () => state, publishGoal(goal) { state.goal = goal } },
    events: { getSnapshot: () => ({ entries: [] }), subscribe: noopSubscribe },
    queueStore: { getSnapshot: () => [], subscribe: noopSubscribe },
    updateState(edit) {
      edit(state)
      if (state.goalReplacement) confirmationReady?.resolve(state.goalReplacement)
    },
  }
  const goalDraft = { getSnapshot: () => draft, subscribe: noopSubscribe, clear(value) { if (draft === value) draft = undefined } }
  const model = { getSnapshot: () => undefined, clear() {} }
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native', history, model, undefined, undefined, undefined, goalDraft)
  const statuses = []
  function send() {
    confirmationReady = Promise.withResolvers()
    const { requestId } = input.beginSubmission({ mode: 'queue', text: '新目标', attachments: [], onAccept: () => statuses.push('接纳') })
    return input.prompt([{ type: 'text', text: '新目标' }], 'queue', undefined, requestId)
  }

  const cancelled = send()
  await new Promise(setImmediate)
  assert.deepEqual(state.goalReplacement, { objective: '旧目标', createdAt: 100 })
  assert.deepEqual(requests, [])
  input.decideGoalReplacement(false)
  assert.equal((await cancelled).ok, false)
  assert.deepEqual(draft, { budget: '250' })

  const confirmed = send()
  await confirmationReady.promise
  input.decideGoalReplacement(true)
  assert.equal((await confirmed).ok, true)
  assert.equal(draft, undefined)
  assert.deepEqual(statuses, ['接纳'])
  assert.deepEqual(state.goal, next)
  assert.deepEqual(state.pendingSubmissions, [])
  assert.deepEqual(requests, [['/api/codex/command-action', { threadId: 'native', action: 'goal-create', objective: '新目标',
    tokenBudget: 250, expectedGoal: { objective: '旧目标', createdAt: 100 } }]])
})

test('原生队列先确认图片送达，后续 HTTP 失败不打断输入交接', async t => {
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
  await new Promise(setImmediate)
  assert.equal(globalThis.fetch.mock.callCount(), 1)

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

test('工作树草稿失败后保留提交身份，成功时接纳并打开原生目标', async t => {
  const worktree = { kind: 'new', id: crypto.randomUUID(), baseRef: 'refs/heads/main' }
  const thread = { id: 'new-native', cwd: '/new-worktree' }
  const lifecycle = []
  let selected = worktree
  let selectedModel = { model: 'mock-model' }
  let fail = true
  const draft = { getSnapshot: () => selected, clear(value) { if (selected === value) selected = undefined } }
  const model = { getSnapshot: () => selectedModel, clear(value) { if (selectedModel === value) selectedModel = undefined } }
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
    draft, (result, confirmed, handoff) => { handoff?.(); lifecycle.push(result.thread.id) })
  async function send() {
    const { requestId } = input.beginSubmission({ mode: 'queue', text: '开始', attachments: [],
      onAccept: () => lifecycle.push('accepted'), onRetire: result => lifecycle.push(result.reason) })
    return input.prompt([{ type: 'text', text: '开始' }], 'queue', undefined, requestId)
  }
  assert.equal((await send()).ok, false)
  assert.equal(selected, worktree)
  assert.deepEqual(selectedModel, { model: 'mock-model' })
  fail = false
  assert.equal((await send()).ok, true)
  assert.equal(selected, undefined)
  assert.equal(selectedModel, undefined)
  assert.deepEqual(lifecycle, ['failed', 'accepted', 'observed', thread.id])
})


test('拒绝旧回执接纳已编辑草稿时保留输入和目标会话入口', async t => {
  const worktree = { kind: 'new', id: crypto.randomUUID(), baseRef: 'refs/heads/main' }
  const recovery = { thread: { id: 'other-native', cwd: '/worktree' }, workspacePaths: {} }
  let selected = worktree
  const draft = { getSnapshot: () => selected, set: value => { selected = value }, clear() { assert.fail('草稿未送达') } }
  const model = { getSnapshot: () => undefined, clear() { assert.fail('草稿未送达') } }
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
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '已编辑', reason: 'worktree-input-changed',
    worktreeRecovery: recovery }, { status: 409 }))
  const input = createSessionInput({ effect: effect => t.after(effect()) }, 'native-draft', history,
    model, undefined, draft, () => assert.fail('失败时保留用户当前会话'))
  const { requestId } = input.beginSubmission({ mode: 'queue', text: '修改后的草稿', attachments: [],
    onAccept: () => assert.fail('原消息的回执不能接纳新草稿') })
  const result = await input.prompt([{ type: 'text', text: '修改后的草稿' }], 'queue', undefined, requestId)
  assert.equal(result.ok, false)
  assert.equal(selected.id, worktree.id)
  assert.deepEqual(selected.recovery, recovery)
})
