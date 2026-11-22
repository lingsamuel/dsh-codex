import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { readCodex } from '../src/host/app-server.mjs'
import { createConversationActionRoute } from '../src/host/conversation-actions.mjs'
import { createHistoryRoutes } from '../src/host/history.mjs'

async function fakeCodex(t, methods) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'rpc-'))
  const socketPath = join(directory, 'app.sock')
  const http = createServer()
  const ws = new WebSocketServer({ server: http })
  const messages = []
  const clientClosed = new Promise(resolve => {
    ws.once('connection', client => client.once('close', resolve))
  })
  ws.on('connection', client => {
    client.on('message', async message => {
      const request = JSON.parse(message.toString())
      messages.push(request)
      if (request.id === undefined) return
      const reply = request.method === 'initialize'
        ? { result: { userAgent: 'test Codex', codexHome: directory } }
        : await methods[request.method]?.(request.params, client)
      client.send(JSON.stringify({
        id: request.id,
        ...(reply ?? { error: { code: -32601, message: 'method not found' } }),
      }))
    })
  })
  http.listen(socketPath)
  await once(http, 'listening')
  t.after(async () => {
    for (const client of ws.clients) client.terminate()
    ws.close()
    const closed = once(http, 'close')
    http.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  const owner = new AbortController()
  t.after(() => owner.abort())
  const routes = createHistoryRoutes(socketPath, owner.signal)
  const get = (path, options) => routes.find(route => path.split('?')[0] === route.path)
    ?.fetch(new Request(`http://localhost${path}`, options)) ?? Response.json({}, { status: 404 })
  return {
    get, messages, clientClosed, socketPath, directory,
    broadcast(message) {
      for (const client of ws.clients) client.send(JSON.stringify(message))
    },
  }
}

function postCommand(get, action, fields) {
  return get('/api/codex/command-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'main', action, ...fields }),
  })
}

test('网页命令仅在冷会话队列为空时恢复并压缩上下文', async t => {
  const thread = { id: 'main', status: { type: 'notLoaded' } }
  let queued = [{ id: 'later' }]
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => ({ result: { data: queued } }),
    'thread/resume': () => {
      thread.status.type = 'idle'
      return { result: { thread } }
    },
    'thread/turns/list': () => ({ result: { data: [{ id: 'previous', status: 'completed' }] } }),
    'thread/compact/start': () => {
      thread.status.type = 'active'
      return { result: {} }
    },
  })
  assert.equal((await postCommand(get, 'compact')).status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/resume' || method === 'thread/compact/start'), false)
  queued = []
  assert.equal((await postCommand(get, 'compact')).status, 200)
  assert.deepEqual(messages.filter(({ method }) => ['thread/resume', 'thread/compact/start'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['thread/resume', { threadId: 'main', excludeTurns: true }],
    ['thread/compact/start', { threadId: 'main' }],
  ])
  assert.equal((await postCommand(get, 'compact')).status, 409)
  assert.equal(messages.filter(({ method }) => method === 'thread/compact/start').length, 1)
})

test('网页审查使用当前线程并传递四种原生目标', async t => {
  let activity = 'idle'
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: activity } } } }),
    'review/start': () => {
      activity = 'active'
      return { result: { reviewThreadId: 'main', turn: { id: 'review' } } }
    },
  })
  const targets = [{ type: 'uncommittedChanges' }, { type: 'baseBranch', branch: 'release/v2' },
    { type: 'commit', sha: 'abc123', title: null }, { type: 'custom', instructions: '核对配置兼容性' }]
  for (const target of targets) {
    assert.equal((await postCommand(get, 'review', { target })).status, 200)
    activity = 'idle'
  }
  assert.equal((await postCommand(get, 'review', { target: { type: 'commit', sha: ' ' } })).status, 400)
  assert.deepEqual(messages.filter(({ method }) => method === 'review/start').map(({ params }) => params),
    targets.map(target => ({ threadId: 'main', target })))
})

test('网页审查在冷恢复期间启动了其他轮次时不打断它', async t => {
  const thread = { id: 'main', status: { type: 'notLoaded' } }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => ({ result: { data: [] } }),
    'thread/resume': () => {
      thread.status.type = 'active'
      return { result: { thread: { ...thread, status: { type: 'idle' } } } }
    },
  })
  const response = await postCommand(get, 'review', { target: { type: 'uncommittedChanges' } })
  assert.equal(response.status, 409)
  assert.equal(messages.some(({ method }) => method === 'review/start'), false)
})

test('网页计划模式目录只读，切换保留会话模型并等待原生确认', async t => {
  const thread = { id: 'main', status: { type: 'idle' }, model: 'current-model', reasoningEffort: 'high' }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [{ id: 'previous', status: 'completed' }] } }),
    'collaborationMode/list': () => ({ result: { data: [
      { name: 'Default', mode: 'default' }, { name: 'Plan', mode: 'plan', model: 'other-model' }, { name: 'Extra', mode: null },
    ] } }),
    'thread/resume': () => ({ result: { thread, collaborationMode: { mode: 'default' } } }),
    'thread/settings/update': (params, client) => {
      client.send(JSON.stringify({ method: 'thread/settings/updated', params: {
        threadId: 'another-thread', threadSettings: { collaborationMode: { mode: 'default' } },
      } }))
      client.send(JSON.stringify({ method: 'thread/settings/updated', params: {
        threadId: 'main', threadSettings: { collaborationMode: params.collaborationMode },
      } }))
      return { result: {} }
    },
  })
  assert.deepEqual((await (await get('/api/codex/thread-info?threadId=main&view=plan')).json()).modes, ['default', 'plan'])
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
  assert.deepEqual(await (await postCommand(get, 'plan', { mode: 'plan' })).json(), { mode: 'plan', confirmed: true })
  assert.deepEqual(messages.find(({ method }) => method === 'thread/settings/update').params, {
    threadId: 'main', collaborationMode: { mode: 'plan', settings: {
      model: 'current-model', reasoning_effort: 'high', developer_instructions: null,
    } },
  })
})

test('网页空白会话从原生创建连接确认计划模式', async t => {
  const thread = { id: 'main', cwd: '/workspace', status: { type: 'idle' }, model: 'current-model' }
  let creation
  const { get, messages } = await fakeCodex(t, {
    'thread/start': (params, client) => {
      creation = client
      return { result: { thread } }
    },
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'collaborationMode/list': () => ({ result: { data: [{ mode: 'default' }, { mode: 'plan' }] } }),
    'thread/settings/update': ({ collaborationMode }) => {
      creation.send(JSON.stringify({ method: 'thread/settings/updated', params: {
        threadId: 'main', threadSettings: { collaborationMode },
      } }))
      return { result: {} }
    },
  })
  const created = await get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', cwd: thread.cwd }),
  })
  assert.equal(created.status, 200)
  assert.deepEqual(await (await postCommand(get, 'plan', { mode: 'plan' })).json(), { mode: 'plan', confirmed: true })
  assert.deepEqual(await (await get('/api/codex/thread-info?threadId=main&view=plan')).json(), {
    modes: ['default', 'plan'], mode: 'plan',
  })
  const watch = await get('/api/codex/watch?threadId=main')
  const reader = watch.body.getReader()
  t.after(() => reader.cancel())
  const { value } = await reader.read()
  const snapshot = JSON.parse(new TextDecoder().decode(value).slice(6))
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.planMode, 'plan')
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
})

test('其他客户端的空白会话用原生设置回执确认计划模式', async t => {
  const thread = { id: 'main', status: { type: 'idle' }, model: 'native-model' }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }),
    'collaborationMode/list': () => ({ result: { data: [{ mode: 'plan' }] } }),
    'thread/settings/update': () => ({ result: {} }),
  })
  assert.deepEqual(await (await postCommand(get, 'plan', { mode: 'plan' })).json(), { mode: 'plan', confirmed: true })
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
})

test('网页目标的创建、暂停、恢复与清除使用原生用户身份', async t => {
  let goal = null
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: 'active' } } } }),
    'thread/goal/get': () => ({ result: { goal } }),
    'thread/goal/set': ({ objective, tokenBudget, status }) => {
      goal = { ...goal, ...(objective && { objective, tokenBudget }), status }
      return { result: { goal } }
    },
    'thread/goal/clear': () => { goal = null; return { result: { cleared: true } } },
  })
  const objective = '完成兼容性检查'
  const tokenBudget = 4000
  assert.deepEqual(await (await postCommand(get, 'goal-create', { objective, tokenBudget })).json(), {
    goal: { objective, tokenBudget, status: 'active' },
  })
  assert.equal((await postCommand(get, 'goal-create', { objective: '新目标' })).status, 409)
  assert.equal((await (await postCommand(get, 'goal-pause')).json()).goal.status, 'paused')
  assert.equal((await (await postCommand(get, 'goal-resume')).json()).goal.status, 'active')
  assert.deepEqual(await (await postCommand(get, 'goal-clear', { expectedGoal: { objective } })).json(), { goal: null })
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/goal/set' || method === 'thread/goal/clear')
    .map(({ method, params }) => [method, params]), [
    ['thread/goal/set', { threadId: 'main', origin: 'user', objective, tokenBudget, status: 'active' }],
    ['thread/goal/set', { threadId: 'main', origin: 'user', status: 'paused' }],
    ['thread/goal/set', { threadId: 'main', origin: 'user', status: 'active' }],
    ['thread/goal/clear', { threadId: 'main', origin: 'user' }],
  ])
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
})

test('网页清除目标时拒绝移除后来创建的目标', async t => {
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: 'idle' } } } }),
    'thread/goal/get': () => ({ result: { goal: { objective: '核对依赖', createdAt: 200, status: 'paused' } } }),
  })
  const response = await postCommand(get, 'goal-clear', { expectedGoal: { objective: '核对依赖', createdAt: 100 } })
  assert.equal(response.status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/goal/clear'), false)
})

test('网页目标在显式取消归档后读取原生目标', async t => {
  const thread = { id: 'main', archived: true, status: { type: 'notLoaded' } }
  const goal = { objective: '已保存目标', status: 'paused' }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: thread.archived ? [thread] : [] } }),
    'thread/goal/get': () => thread.archived ? { error: { code: -32600, message: 'thread not found: main' } } : { result: { goal } },
    'thread/unarchive': () => {
      thread.archived = false
      return { result: { thread } }
    },
  })
  const opened = await get('/api/codex/thread-info?threadId=main&view=goal')
  assert.deepEqual(await opened.json(), { goal: null, goalRequiresUnarchive: true })
  assert.equal(thread.archived, true)
  assert.deepEqual(await (await postCommand(get, 'goal-unarchive', { unarchive: true })).json(), { goal })
  assert.equal(thread.archived, false)
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
})

test('工作区改名、排序和删除返回 Codex 原生项目列表', async t => {
  const alpha = { id: 'alpha', name: 'Alpha', roots: [] }
  const beta = { id: 'beta', name: 'Beta', roots: [] }
  let projects = [alpha, beta]
  const { get, messages } = await fakeCodex(t, {
    'project/update': ({ name }) => {
      alpha.name = name
      return { result: { project: alpha } }
    },
    'project/move': () => {
      projects = [beta, alpha]
      return { result: {} }
    },
    'project/delete': () => {
      projects = [beta]
      return { result: {} }
    },
    'project/list': () => ({ result: { data: projects, nextCursor: null } }),
  })
  const post = body => get('/api/codex/project-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.deepEqual((await (await post({ action: 'rename', projectId: 'alpha', name: 'Renamed' })).json()).projects,
    [{ ...alpha, name: 'Renamed' }, beta])
  assert.deepEqual((await (await post({ action: 'move', projectId: 'beta', beforeProjectId: 'alpha' })).json()).projects,
    [beta, alpha])
  assert.deepEqual((await (await post({ action: 'delete', projectId: 'alpha' })).json()).projects, [beta])
  assert.deepEqual(messages.filter(({ method }) => ['project/update', 'project/move', 'project/delete'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['project/update', { projectId: 'alpha', name: 'Renamed' }],
    ['project/move', { projectId: 'beta', beforeProjectId: 'alpha' }],
    ['project/delete', { projectId: 'alpha' }],
  ])
})

async function titleFixture(t, { initialItem, modelResult = 'success', waitForModel, waitForClaim, provider = 'openai',
  account = 'chatgpt', luna = true, defer = false, emptyRollout = false, unindexedHistory = false } = {}) {
  const thread = { id: 'main', cwd: '/workspace', historyMode: 'paginated', status: { type: 'idle' },
    model: 'main-model', modelProvider: provider, preview: initialItem ? '旧消息' : '' }
  const text = { type: 'text', text: '请检查网页标题逻辑', text_elements: [] }
  const queue = new Map()
  const events = new EventEmitter()
  let turn = initialItem ? { id: 'first-turn', items: [initialItem] } : undefined
  let started = 0
  let detached = false
  const fixture = await fakeCodex(t, {
    'thread/read': () => {
      if (turn && emptyRollout) {
        emptyRollout = false
        return { error: { code: -32603, message: 'failed to read thread: rollout at /workspace/draft.jsonl is empty' } }
      }
      return { result: { thread } }
    },
    'thread/turns/list': () => {
      events.emit(detached ? 'title-revalidation' : 'history-read')
      if (turn && unindexedHistory) {
        unindexedHistory = false
        return { error: { code: -32601, message: 'list_turns is not supported yet' } }
      }
      return turn ? { result: { data: [turn], nextCursor: null } }
        : { error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }
    },
    'thread/queue/list': () => {
      events.emit('queue-read')
      return { result: { data: [...queue.values()], nextCursor: null } }
    },
    'thread/queue/add': ({ clientUserMessageId, input }) => {
      const queuedSubmission = { id: clientUserMessageId, clientUserMessageId, input }
      queue.set(queuedSubmission.id, queuedSubmission)
      if (!defer && !turn) claim(queuedSubmission)
      return { result: { queuedSubmission } }
    },
    'thread/queue/delete': ({ queuedSubmissionId }) => ({ result: { deleted: queue.delete(queuedSubmissionId) } }),
    'thread/queue/start': ({ queuedSubmissionId }) => {
      const submission = queue.get(queuedSubmissionId) ?? queue.values().next().value
      if (waitForClaim) {
        queue.delete(submission.id)
        fixture.broadcast({ method: 'thread/queue/changed', params: { threadId: thread.id } })
        void waitForClaim.then(() => claim(submission))
      } else claim(submission)
      return { result: { turn: { id: 'first-turn', items: [] } } }
    },
    'account/read': () => ({ result: { account: { type: account } } }),
    'model/list': () => ({ result: { data: luna ? [{ model: 'gpt-5.6-luna' }] : [] } }),
    'config/read': () => ({ result: { config: { mcp_servers: { fixture: { enabled: true } } } } }),
    'thread/start': params => {
      assert.equal(params.ephemeral, true)
      return { result: { thread: { id: 'title-thread', ephemeral: true }, sandbox: { type: 'readOnly' },
        approvalPolicy: 'never' } }
    },
    'turn/start': async (params, client) => {
      started++
      const startedTurn = { id: 'title-turn', status: 'inProgress', items: [] }
      events.emit('title-started', params)
      const finish = () => {
        const send = (method, params) => client.send(JSON.stringify({ method, params }))
        if (modelResult === 'success') send('item/completed', { threadId: 'title-thread', turnId: startedTurn.id,
          item: { type: 'agentMessage', phase: 'final_answer', text: '{"title":"检查网页标题"}' } })
        send('turn/completed', { threadId: 'title-thread', turn: { ...startedTurn,
          status: modelResult === 'success' ? 'completed' : 'failed' } })
      }
      if (waitForModel) void waitForModel.then(finish)
      else finish() // 轮次事件可能早于 turn/start 的响应。
      return { result: { turn: startedTurn } }
    },
    'thread/unsubscribe': () => {
      detached = true
      return { result: {} }
    },
    'thread/name/set': ({ threadId, name }) => {
      assert.equal(threadId, thread.id)
      thread.name = name
      fixture.broadcast({ method: 'thread/name/updated', params: { threadId, threadName: name } })
      events.emit('title-saved', name)
      return { result: {} }
    },
  })
  function claim(submission) {
    queue.delete(submission.id)
    turn = { id: 'first-turn', items: [{ type: 'userMessage', clientId: submission.clientUserMessageId,
      id: `item-${submission.id}`, content: submission.input }] }
    thread.preview = submission.input.find(part => part.type === 'text')?.text ?? ''
    thread.status = { type: 'active' }
    fixture.broadcast({ method: 'thread/status/changed', params: { threadId: thread.id, status: thread.status } })
  }
  const post = (fields, route = 'conversation-action') => fixture.get(`/api/codex/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: thread.id, ...fields }),
  })
  return {
    ...fixture, thread, post, text,
    send: (clientUserMessageId = 'first', input = [text]) => post({ action: 'prompt', mode: 'queue', clientUserMessageId, input }),
    wait: event => once(events, event, { signal: AbortSignal.timeout(2_000) }),
    inferenceCount: () => started,
    replaceFirstItem: item => { turn.items[0] = item },
  }
}

test('网页首条消息进入历史后只用一个临时轮次拟标题，并通过原生事件更新目录', async t => {
  const adopt = Promise.withResolvers()
  const title = await titleFixture(t, { defer: true, waitForClaim: adopt.promise })
  title.thread.status = { type: 'active', activeFlags: [] }
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await title.get('/api/codex/watch?scope=catalog', { signal: abort.signal })
  const reader = response.body.getReader()
  try {
    const decoder = new TextDecoder()
    let pending = ''
    async function frameWhere(predicate) {
      while (true) {
        const boundary = pending.indexOf('\n\n')
        if (boundary < 0) {
          const next = await reader.read()
          assert.equal(next.done, false)
          pending += decoder.decode(next.value, { stream: true })
          continue
        }
        const message = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (!message.startsWith('data: ')) continue
        const frame = JSON.parse(message.slice(6))
        if (predicate(frame)) return frame
      }
    }
    await frameWhere(frame => frame.type === 'catalog-ready')
    const observedQueue = title.wait('queue-read')
    assert.equal((await title.send()).status, 200)
    await observedQueue
    assert.equal(title.inferenceCount(), 0)
    assert.equal((await title.send()).status, 200)
    title.thread.status = { type: 'idle' }
    assert.equal((await title.post({ action: 'queue', operation: 'start', queuedSubmissionId: 'first' })).status, 200)
    await delay(1_200)
    assert.equal(title.inferenceCount(), 0)
    const saved = title.wait('title-saved')
    adopt.resolve()
    assert.deepEqual(await saved, ['检查网页标题'])
    assert.equal(title.inferenceCount(), 1)
    const update = await frameWhere(frame => frame.type === 'thread' && frame.id === title.thread.id)
    assert.equal(update.thread.name, '检查网页标题')
    const opening = title.messages.find(({ method }) => method === 'thread/start').params
    assert.equal(opening.model, 'gpt-5.6-luna')
    assert.equal(opening.threadSource, 'thread_title')
    assert.equal(opening.config.mcp_servers.fixture.enabled, false)
    assert.deepEqual(opening.environments, [])
    const turn = title.messages.find(({ method }) => method === 'turn/start').params
    assert.equal(turn.threadId, 'title-thread')
    assert.equal(turn.effort, 'low')
    assert.ok(turn.outputSchema.properties.title)
    assert.match(turn.input[0].text, /网页标题逻辑/)
    assert.ok(title.messages.some(({ method, params }) => method === 'thread/unsubscribe' && params.threadId === 'title-thread'))
  } finally {
    await reader.cancel()
  }
})

test('标题推理失败时写回首条文本摘录，并对第三方 provider 沿用原模型', async t => {
  const title = await titleFixture(t, { modelResult: 'failure', provider: 'custom' })
  const saved = title.wait('title-saved')
  assert.equal((await title.send()).status, 200)
  assert.deepEqual(await saved, [title.text.text])
  const opening = title.messages.find(({ method }) => method === 'thread/start').params
  assert.equal(opening.model, title.thread.model)
  assert.equal(opening.modelProvider, 'custom')
  assert.equal(title.inferenceCount(), 1)
})

test('首条消息写入期间原生会话记录短暂为空时继续拟标题', async t => {
  const title = await titleFixture(t, { emptyRollout: true, unindexedHistory: true })
  const saved = title.wait('title-saved')
  assert.equal((await title.send()).status, 200)
  assert.deepEqual(await saved, ['检查网页标题'])
})

test('模型返回前手动改名时保留手动标题', async t => {
  const model = Promise.withResolvers()
  const title = await titleFixture(t, { waitForModel: model.promise })
  const started = title.wait('title-started')
  assert.equal((await title.send()).status, 200)
  await started
  assert.equal((await title.post({ action: 'rename', name: '手动标题' }, 'thread-action')).status, 200)
  const revalidated = title.wait('title-revalidation')
  model.resolve()
  await revalidated
  await delay(20)
  assert.equal(title.thread.name, '手动标题')
  assert.equal(title.messages.filter(({ method }) => method === 'thread/name/set').length, 1)
})

test('首条消息在拟标题期间发生变化时丢弃旧结果', async t => {
  const model = Promise.withResolvers()
  const title = await titleFixture(t, { waitForModel: model.promise })
  const started = title.wait('title-started')
  assert.equal((await title.send()).status, 200)
  await started
  title.replaceFirstItem({ type: 'userMessage', clientId: 'replacement', id: 'replacement-item', content: [title.text] })
  const revalidated = title.wait('title-revalidation')
  model.resolve()
  await revalidated
  await delay(20)
  assert.equal(title.thread.name, undefined)
  assert.equal(title.messages.some(({ method }) => method === 'thread/name/set'), false)
})

test('纯图片首条消息和续写旧会话沿用原生预览', async t => {
  const image = { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' }
  const imageTitle = await titleFixture(t)
  const readImage = imageTitle.wait('history-read')
  assert.equal((await imageTitle.send('first-image', [image])).status, 200)
  await readImage
  assert.equal((await imageTitle.send('followup')).status, 200)
  const oldTitle = await titleFixture(t, { initialItem: { type: 'userMessage', id: 'existing', content: [imageTitle.text] } })
  assert.equal((await oldTitle.send()).status, 200)
  await delay(20)
  assert.equal(imageTitle.inferenceCount() + oldTitle.inferenceCount(), 0)
})

test('普通发送按需恢复原生会话，恢复失败时保留消息未入队', async t => {
  const thread = { id: 'native-thread', cwd: '/mock', status: { type: 'notLoaded' } }
  const input = [{ type: 'text', text: '请继续', text_elements: [] }]
  const queuedSubmission = { id: 'queued-id', clientUserMessageId: 'browser-id', input }
  let canResume = false
  const { socketPath, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/start': () => ({ result: { thread } }),
    'thread/resume': () => {
      if (!canResume) return { error: { code: -32600, message: 'Provider unavailable' } }
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/queue/add': () => ({ result: { queuedSubmission } }),
    'thread/queue/list': () => ({ result: { data: [], nextCursor: null } }),
    'turn/steer': ({ expectedTurnId }) => expectedTurnId === 'active-turn' ? { result: { turnId: 'active-turn' } }
      : { error: { code: -32600, message: 'expected active turn id `stale-turn` but found `active-turn`' } },
    'turn/interrupt': () => ({ result: {} }),
  })
  const route = createConversationActionRoute(socketPath)
  const post = (action, fields) => route.fetch(new Request('http://local/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }),
  }))

  assert.equal((await post('thread/start', { cwd: thread.cwd })).status, 400)
  assert.deepEqual((await (await post('create', { cwd: thread.cwd, projectId: 'project-id', approvalPolicy: 'never' })).json()).thread,
    { ...thread, blank: true })
  const blocked = await post('prompt', { threadId: thread.id, mode: 'queue', input, clientUserMessageId: 'browser-id' })
  assert.match((await blocked.json()).error, /Provider unavailable/)
  assert.equal(messages.some(({ method }) => method === 'thread/queue/add'), false)
  canResume = true
  assert.deepEqual(await (await post('prompt', { threadId: thread.id, mode: 'queue', input, clientUserMessageId: 'browser-id' })).json(), { queuedSubmission })
  thread.status = { type: 'active' }
  assert.deepEqual(await (await post('prompt', { threadId: thread.id, mode: 'steer', input, clientUserMessageId: 'browser-id' })).json(), { queuedSubmission })
  assert.deepEqual(await (await post('prompt', { threadId: thread.id, mode: 'steer', input, clientUserMessageId: 'browser-id', expectedTurnId: 'stale-turn' })).json(), { queuedSubmission })
  assert.equal((await post('prompt', { threadId: thread.id, mode: 'steer', input, clientUserMessageId: 'browser-id', expectedTurnId: 'active-turn' })).status, 200)
  assert.equal((await post('cancel', { threadId: thread.id, turnId: 'active-turn' })).status, 200)
  assert.deepEqual(messages.filter(({ method }) => /^(thread|turn)\//.test(method) && method !== 'thread/read')
    .map(({ method, params }) => [method, params]), [
    ['thread/start', { cwd: thread.cwd, historyMode: 'paginated', projectId: 'project-id' }],
    ['thread/resume', { threadId: thread.id, excludeTurns: true }],
    ['thread/resume', { threadId: thread.id, excludeTurns: true }],
    ['thread/queue/add', { threadId: thread.id, input, clientUserMessageId: 'browser-id' }],
    ['thread/queue/list', { threadId: thread.id, limit: 2 }],
    ['thread/queue/add', { threadId: thread.id, input, clientUserMessageId: 'browser-id' }],
    ['turn/steer', { threadId: thread.id, input, clientUserMessageId: 'browser-id', expectedTurnId: 'stale-turn' }],
    ['thread/queue/add', { threadId: thread.id, input, clientUserMessageId: 'browser-id' }],
    ['turn/steer', { threadId: thread.id, input, clientUserMessageId: 'browser-id', expectedTurnId: 'active-turn' }],
    ['turn/interrupt', { threadId: thread.id, turnId: 'active-turn' }],
  ])
})

test('中断后空闲发送会启动唯一的新稿，既有待发消息仍由继续队列控制', async t => {
  const cases = [
    { name: '启动暂停队列中唯一的新稿', pending: [] },
    { name: '保留此前暂停的队列', pending: [{ id: 'old', clientUserMessageId: 'held' }] },
    { name: '初次读取后轮次中断，仍能启动新稿', pending: [], wasActive: true },
  ]
  for (const { name, pending, wasActive } of cases) {
    await t.test(name, async t => {
      const threadId = 'idle-after-interrupt'
      const queued = [...pending]
      let status = wasActive ? 'active' : 'idle'
      const { get, messages } = await fakeCodex(t, {
        'thread/read': () => ({ result: { thread: { id: threadId, status: { type: status } } } }),
        'thread/queue/add': params => {
          status = 'idle'
          const queuedSubmission = { id: 'new', ...params }
          queued.push(queuedSubmission)
          return { result: { queuedSubmission } }
        },
        'thread/queue/list': () => ({ result: { data: queued, nextCursor: null } }),
        'thread/queue/start': ({ queuedSubmissionId }) => {
          assert.equal(queuedSubmissionId, 'new')
          queued.shift()
          return { result: { turn: { id: 'next-turn' } } }
        },
      })
      const response = await get('/api/codex/conversation-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          action: 'prompt', threadId, mode: wasActive ? 'queue' : 'steer', expectedTurnId: 'interrupted-turn',
          clientUserMessageId: 'browser', input: [{ type: 'text', text: '新消息' }],
        }),
      })
      assert.equal(response.status, 200)
      assert.equal(messages.some(({ method }) => method === 'turn/steer'), false)
      assert.equal(messages.some(({ method }) => method === 'thread/queue/start'), !pending.length)
      assert.deepEqual(queued.map(({ id }) => id), pending.length ? ['old', 'new'] : [])
    })
  }
})

test('发送归档会话先按原生目录确认，再取消归档并恢复同一个线程', async t => {
  const thread = { id: 'archived-thread', status: { type: 'notLoaded' } }
  let archived = true
  let canResume = false
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': ({ archived: onlyArchived, includedThreadIds }) => ({ result: {
      data: archived && onlyArchived && includedThreadIds.includes(thread.id) ? [thread] : [], nextCursor: null,
    } }),
    'thread/unarchive': () => {
      archived = false
      return { result: { thread } }
    },
    'thread/resume': () => {
      assert.equal(archived, false)
      if (!canResume) return { error: { code: -32600, message: 'fixture runtime unavailable' } }
      thread.status = { type: 'active' }
      return { result: { thread } }
    },
    'thread/queue/add': () => ({ result: { accepted: true } }),
  })
  const send = () => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'prompt', threadId: thread.id, input: [{ type: 'text', text: '继续原会话' }],
      clientUserMessageId: 'draft', mode: 'queue', unarchive: true,
    }),
  })
  const failed = await send()
  assert.match((await failed.json()).error, /恢复会话.*fixture runtime unavailable/)
  assert.equal(archived, false)
  assert.equal(messages.some(({ method }) => method === 'thread/queue/add'), false)
  canResume = true
  assert.equal((await send()).status, 200)
  assert.deepEqual(messages.map(({ method }) => method).filter(method => method.startsWith('thread/') && method !== 'thread/read'),
    ['thread/list', 'thread/unarchive', 'thread/resume', 'thread/list', 'thread/resume', 'thread/queue/add'])
  assert.deepEqual(messages.find(({ method }) => method === 'thread/list').params,
    { archived: true, includedThreadIds: [thread.id], modelProviders: [], limit: 1 })
})

test('恢复归档会话时，在原生 queue 可能启动前应用草稿模型和权限', async t => {
  for (const action of ['prompt', 'queue']) {
    await t.test(action, async t => {
      const thread = { id: 'archive-settings', cwd: '/workspace', preview: 'old', modelProvider: 'openai',
        model: 'old', status: { type: 'notLoaded' } }
      const target = { id: 'first', clientUserMessageId: 'prior' }
      let archived = true
      let settings
      const { get, messages } = await fakeCodex(t, {
        'thread/read': () => ({ result: { thread } }),
        'permissionProfile/list': () => ({ result: { data: [{ id: ':read-only', allowed: true }] } }),
        'thread/list': () => ({ result: { data: archived ? [thread] : [] } }),
        'thread/unarchive': () => { archived = false; return { result: { thread } } },
        'thread/queue/list': () => ({ result: { data: [target], nextCursor: null } }),
        'thread/resume': params => {
          assert.equal(archived, false)
          settings = params
          thread.model = params.model ?? thread.model
          thread.reasoningEffort = params.config?.model_reasoning_effort
          thread.status = { type: 'active' }
          return { result: { thread, activePermissionProfile: params.permissions ? { id: params.permissions } : null } }
        },
        'thread/settings/update': () => {
          Object.assign(thread, { model: 'selected', reasoningEffort: 'high' })
          return { result: {} }
        },
        'thread/turns/list': () => ({ result: { data: [] } }),
        'thread/queue/add': () => ({ result: { accepted: true } }),
        'thread/queue/start': () => ({ result: { accepted: true } }),
      })
      const fields = { action, threadId: thread.id, unarchive: true, modelDraft: { provider: 'openai', model: 'selected', reasoningEffort: 'high' },
        ...(action === 'prompt' ? { input: [{ type: 'text', text: '继续' }], clientUserMessageId: 'new', mode: 'queue' } : { operation: 'start' }) }
      const submit = permissionDraft => get('/api/codex/conversation-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, permissionDraft }),
      })
      assert.equal((await submit('unavailable-profile')).status, 400)
      assert.equal(archived, true)
      const accepted = await submit(':read-only')
      assert.equal(accepted.status, 200)
      assert.equal((await accepted.json()).permission?.profileId, ':read-only')
      assert.deepEqual(settings, { threadId: thread.id, excludeTurns: true, model: 'selected', config: { model_reasoning_effort: 'high' }, permissions: ':read-only' })
      assert.equal(messages.filter(({ method }) => method === 'thread/resume').length, 1)
      assert.equal(messages.some(({ method }) => method === 'thread/settings/update'), false)
    })
  }
})

test('另一客户端已恢复归档会话并清空队列时，不提交草稿设置', async t => {
  const thread = { id: 'empty-archive-queue', cwd: '/workspace', modelProvider: 'openai', status: { type: 'idle' } }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => ({ result: { data: [] } }),
    'permissionProfile/list': () => ({ result: { data: [{ id: ':read-only', allowed: true }] } }),
  })
  const response = await get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'queue', operation: 'start', unarchive: true, threadId: thread.id,
      modelDraft: { provider: 'openai', model: 'selected' }, permissionDraft: ':read-only',
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { queueEmpty: true })
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method }) => method),
    ['thread/read', 'thread/list', 'thread/read', 'thread/queue/list'])
})

test('查看归档会话的队列只在确认后取消归档，保持运行时未加载', async t => {
  const thread = { id: 'archive-queue-view', status: { type: 'notLoaded' } }
  const target = { id: 'queued', input: [{ type: 'text', text: '待发送' }] }
  let archived = true
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: archived ? [thread] : [] } }),
    'thread/unarchive': () => { archived = false; return { result: { thread } } },
    'thread/queue/list': () => archived ? { error: { code: -32600, message: 'session is archived' } }
      : { result: { data: [target], nextCursor: null } },
  })
  const list = unarchive => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'queue', operation: 'list', threadId: thread.id, unarchive,
    }),
  })
  assert.equal((await list(false)).status, 400)
  assert.equal(archived, true)
  assert.deepEqual(await (await list(true)).json(), { data: [target] })
  assert.equal(archived, false)
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method }) => method),
    ['thread/queue/list', 'thread/read', 'thread/list', 'thread/unarchive', 'thread/queue/list'])
})

test('继续归档会话的队列先取消归档，再确认目标消息', async t => {
  const thread = { id: 'archived-queue', status: { type: 'notLoaded' } }
  const target = { id: 'first', clientUserMessageId: 'browser' }
  let archived = true
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: archived ? [thread] : [], nextCursor: null } }),
    'thread/unarchive': () => {
      archived = false
      return { result: { thread } }
    },
    'thread/queue/list': () => archived ? { error: { code: -32600, message: 'session is archived' } }
      : { result: { data: [target], nextCursor: null } },
    'thread/resume': () => {
      thread.status = { type: 'active' }
      return { result: { thread } }
    },
    'thread/turns/list': () => ({ result: { data: [] } }),
    'thread/queue/start': () => ({ result: { started: true } }),
  })
  const response = await get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'queue', operation: 'start', threadId: thread.id, unarchive: true,
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(messages.filter(({ method }) => ['thread/unarchive', 'thread/queue/list', 'thread/resume', 'thread/queue/start'].includes(method))
    .map(({ method }) => method), ['thread/unarchive', 'thread/queue/list', 'thread/resume', 'thread/queue/start'])
  assert.equal(messages.find(({ method }) => method === 'thread/queue/start').params.queuedSubmissionId, target.id)
})

test('技能候选读取冷会话和归档会话各自的目录，不改变原生会话状态', async t => {
  const threads = {
    cold: { id: 'cold', cwd: '/one', status: { type: 'notLoaded' } },
    archived: { id: 'archived', cwd: '/two', archived: true, status: { type: 'notLoaded' } },
  }
  const { socketPath, messages } = await fakeCodex(t, {
    'thread/read': ({ threadId }) => ({ result: { thread: threads[threadId] } }),
    'skills/list': ({ cwds }) => {
      const [cwd] = cwds
      return { result: { data: [{ cwd, errors: [], skills: [
        { enabled: false, name: 'disabled', path: `${cwd}/disabled/SKILL.md`, description: 'Disabled entry' },
        { enabled: true, name: 'shared', path: `${cwd}/first/SKILL.md`, description: 'Native first',
          interface: { displayName: 'Display name', shortDescription: 'Short description' } },
        { enabled: true, name: 'shared', path: `${cwd}/second/SKILL.md`, description: 'Native second' },
        { enabled: true, name: 'pack:检查', path: `${cwd}/check/SKILL.md`, description: 'Native qualified name' },
      ] }] } }
    },
  })
  const { createSkillsRoute } = await import('../src/host/skills.mjs')
  const route = createSkillsRoute(socketPath)
  for (const { id, cwd } of Object.values(threads)) {
    const response = await route.fetch(new Request(`http://local/api/codex/skills?threadId=${id}&cwd=/untrusted`))
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).skills, [{
      name: 'shared', path: `${cwd}/first/SKILL.md`, label: 'Display name', description: 'Short description',
    }, {
      name: 'pack:检查', path: `${cwd}/check/SKILL.md`, description: 'Native qualified name',
    }])
  }
  assert.deepEqual(messages.filter(({ method }) => /^(skills|thread)\//.test(method)).map(({ method, params }) => [method, params]), [
    ['thread/read', { threadId: 'cold' }], ['skills/list', { cwds: ['/one'] }],
    ['thread/read', { threadId: 'archived' }], ['skills/list', { cwds: ['/two'] }],
  ])
})

test('普通发送和直接插话从实际 Codex 目录解析技能，保留可见正文和原生发送位置', async t => {
  const thread = { id: 'native-skills', cwd: '/old', status: { type: 'notLoaded' } }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/resume': () => {
      thread.cwd = '/resumed'
      thread.status = { type: 'active' }
      return { result: { thread } }
    },
    'skills/list': ({ cwds }) => ({ result: { data: [{ cwd: cwds[0], errors: [], skills: [
      { enabled: false, name: 'review', path: '/disabled/SKILL.md' },
      { enabled: true, name: 'review', path: `${cwds[0]}/review/SKILL.md` },
      { enabled: true, name: 'review', path: '/duplicate/SKILL.md' },
      { enabled: true, name: 'app', path: '/app-skill/SKILL.md' },
      { enabled: true, name: 'pack', path: '/prefix/SKILL.md' },
      { enabled: true, name: 'pack:检查', path: '/qualified/SKILL.md' },
      { enabled: true, name: 'home', path: '/home-skill/SKILL.md' },
    ] }] } }),
    'thread/queue/add': () => ({ result: { accepted: true } }),
    'turn/steer': () => ({ result: { turnId: 'active-turn' } }),
  })
  const post = fields => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'prompt', threadId: thread.id, clientUserMessageId: 'browser', ...fields }),
  })
  const text = { type: 'text', text: '请用 $review 检查，和 $pack:检查 $home。$unknown 和 $PATH。[$app](app://one) \n```sh\n\\$review\n```',
    text_elements: [] }
  const skill = { type: 'skill', name: 'review', path: '/resumed/review/SKILL.md' }
  const qualified = { type: 'skill', name: 'pack:检查', path: '/qualified/SKILL.md' }
  const home = { type: 'skill', name: 'home', path: '/home-skill/SKILL.md' }
  assert.equal((await post({ mode: 'queue', input: [text] })).status, 200)
  assert.equal((await post({ mode: 'steer', expectedTurnId: 'active-turn', input: [text] })).status, 200)
  assert.equal((await post({ mode: 'queue', input: [text, { ...skill, path: '/arbitrary/SKILL.md' }] })).status, 400)
  assert.deepEqual(messages.filter(({ method }) => ['skills/list', 'thread/queue/add', 'turn/steer'].includes(method))
    .map(({ method, params }) => [method, params.cwds ?? params.input]), [
    ['skills/list', ['/resumed']], ['thread/queue/add', [text, skill, qualified, home]],
    ['skills/list', ['/resumed']], ['turn/steer', [text, skill, qualified, home]],
  ])
})

test('队列编辑保留附件与继续引用的原生技能，去掉已删除的技能并识别新技能', async t => {
  const thread = { id: 'queued-skills', cwd: '/actual', status: { type: 'active' } }
  const image = { type: 'localImage', path: '/actual/reference.png' }
  const part = text => ({ type: 'text', text, text_elements: [] })
  const old = { type: 'skill', name: 'old', path: '/old/SKILL.md' }
  const retained = { type: 'skill', name: 'retained', path: '/cli-choice/SKILL.md' }
  const next = { type: 'skill', name: 'next', path: '/actual/next/SKILL.md' }
  const item = { id: 'queued', clientUserMessageId: 'request', input: [part('$old $retained'), image, old, retained] }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'skills/list': () => ({ result: { data: [{ cwd: thread.cwd, errors: [], skills: [
      { ...retained, path: '/default-choice/SKILL.md', enabled: true }, { ...retained, enabled: true }, { ...next, enabled: true },
    ] }] } }),
    'thread/turns/list': () => ({ result: { data: [{ id: 'active', status: 'inProgress' }] } }),
    'thread/queue/list': () => ({ result: { data: [item] } }),
    'thread/queue/update': ({ input }) => {
      item.input = input
      return { result: { queuedSubmission: item } }
    },
    'thread/queue/delete': () => ({ result: { deleted: true } }),
    'turn/steer': () => ({ result: { turnId: 'active' } }),
  })
  const post = fields => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'queue', threadId: thread.id, queuedSubmissionId: item.id, ...fields,
    }),
  })
  const edited = part('$retained 和 $next')
  const result = await post({ operation: 'edit', text: edited.text })
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).queuedSubmission.input, [edited, image, retained, next])
  assert.equal((await post({ operation: 'steer', expectedTurnId: 'active' })).status, 200)
  assert.deepEqual(messages.find(({ method }) => method === 'turn/steer').params.input, [edited, image, retained, next])
})

test('网页图片可单独入队、随文本插话并在队列编辑时保留', async t => {
  const threadId = 'image-thread'
  const image = { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' }
  const text = { type: 'text', text: '查看截图', text_elements: [] }
  const queued = { id: 'image-queue', clientUserMessageId: 'queue-image', input: [image] }
  const { socketPath, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status: { type: 'active' } } } }),
    'thread/queue/add': () => ({ result: { queuedSubmission: queued } }),
    'thread/queue/list': () => ({ result: { data: [queued], nextCursor: null } }),
    'thread/queue/update': ({ input }) => ({ result: { queuedSubmission: { ...queued, input } } }),
    'turn/steer': () => ({ result: { turnId: 'active-turn' } }),
  })
  const route = createConversationActionRoute(socketPath)
  const post = fields => route.fetch(new Request('http://local/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, ...fields }),
  }))
  const queue = { action: 'prompt', mode: 'queue', clientUserMessageId: queued.clientUserMessageId }

  assert.equal((await post({ ...queue, input: [image] })).status, 200)
  assert.equal((await post({ action: 'prompt', mode: 'steer', input: [image, text],
    clientUserMessageId: 'steer-image', expectedTurnId: 'active-turn' })).status, 200)
  const edited = await post({ action: 'queue', operation: 'edit', queuedSubmissionId: queued.id, text: text.text })
  assert.deepEqual((await edited.json()).queuedSubmission.input, [image, text])
  for (const invalid of [{ type: 'image', url: 'https://example.invalid/image.png' },
    { type: 'image', url: 'data:image/png;base64,!' }, { type: 'localImage', path: '/mock/image.png' }]) {
    assert.equal((await post({ ...queue, input: [invalid] })).status, 400)
  }
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/queue/add' || method === 'turn/steer')
    .map(({ method, params }) => [method, params.input]), [['thread/queue/add', [image]], ['turn/steer', [image, text]]])
})

test('队列编辑保留原生附件，显式插话拒绝后保留待发文本', async t => {
  const threadId = 'native-thread'
  const attachment = { type: 'localImage', path: '/mock/image.png' }
  const text = value => ({ type: 'text', text: value, text_elements: [] })
  const item = { id: 'queued-id', clientUserMessageId: 'browser-id', input: [text('before'), attachment] }
  let activeTurnId = 'completed-turn'
  const { socketPath, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status: { type: 'active' } } } }),
    'thread/turns/list': () => ({ result: { data: [{ id: activeTurnId, status: 'inProgress' }] } }),
    'thread/queue/list': ({ cursor }) => ({ result: { data: cursor ? [item] : [], nextCursor: cursor ? null : 'next' } }),
    'thread/queue/update': ({ input }) => {
      item.input = input
      return { result: { queuedSubmission: item } }
    },
    'thread/queue/delete': ({ queuedSubmissionId }) => ({ result: { deleted: queuedSubmissionId === item.id } }),
    'turn/steer': () => ({ error: { code: -32600, message: 'no active turn to steer' } }),
    'thread/queue/add': () => ({ result: { queuedSubmission: { ...item, id: 'restored-id' } } }),
    'thread/queue/start': () => ({ result: { turn: { id: 'resumed-turn' } } }),
  })
  const route = createConversationActionRoute(socketPath)
  const queue = (operation, fields) => route.fetch(new Request('http://local/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'queue', operation, threadId, ...fields }),
  }))

  assert.deepEqual(await (await queue('list')).json(), { data: [item] })
  const edited = await queue('edit', { queuedSubmissionId: item.id, text: 'after' })
  assert.equal(edited.status, 200)
  assert.deepEqual((await edited.json()).queuedSubmission.input, [text('after'), attachment])
  const missing = await queue('remove', { queuedSubmissionId: 'already-claimed' })
  assert.equal(missing.status, 409)
  assert.equal((await missing.json()).reason, 'queue-item-not-found')
  const refused = await queue('steer', { queuedSubmissionId: item.id, expectedTurnId: 'completed-turn' })
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).reason, 'turn-unavailable')
  assert.deepEqual(messages.filter(({ method }) => ['thread/queue/add', 'turn/steer'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['turn/steer', { threadId, input: item.input, clientUserMessageId: item.clientUserMessageId, expectedTurnId: 'completed-turn' }],
    ['thread/queue/add', { threadId, input: item.input, clientUserMessageId: item.clientUserMessageId }],
  ])
  activeTurnId = 'new-turn'
  const before = messages.length
  assert.equal((await queue('steer', { queuedSubmissionId: item.id, expectedTurnId: 'completed-turn' })).status, 409)
  assert.equal(messages.slice(before).some(({ method }) => method === 'thread/queue/delete'), false)
  assert.deepEqual(await (await queue('start')).json(), { turn: { id: 'resumed-turn' } })
  assert.deepEqual(messages.at(-1).params, { threadId })
})

test('并发发送共用首次恢复，原生只接收两条各自的消息', async t => {
  const thread = { id: 'cold', status: { type: 'notLoaded' } }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/resume': async () => {
      await new Promise(resolve => setTimeout(resolve, 45))
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/queue/add': params => ({ result: { queuedSubmission: params } }),
  })
  const send = id => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'prompt', mode: 'queue', threadId: thread.id, clientUserMessageId: id,
      input: [{ type: 'text', text: id }] }),
  })
  const responses = await Promise.all([send('first'), send('second')])
  assert.deepEqual(responses.map(response => response.status), [200, 200])
  assert.equal(messages.filter(({ method }) => method === 'thread/resume').length, 1)
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/queue/add').map(({ params }) => params.clientUserMessageId).sort(),
    ['first', 'second'])
})

test('继续未加载的队列时识别已被原生领取的目标消息', async t => {
  const thread = { id: 'cold', status: { type: 'notLoaded' } }
  const target = { id: 'first', clientUserMessageId: 'first-message' }
  const later = { id: 'second', clientUserMessageId: 'second-message' }
  const turn = { id: 'resumed-turn', items: [{ type: 'userMessage', clientId: target.clientUserMessageId }] }
  let queued = [target, later]
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/queue/list': () => ({ result: { data: queued } }),
    'thread/resume': () => {
      queued = [later]
      thread.status = { type: 'active' }
      return { result: { thread } }
    },
    'thread/turns/list': () => ({ result: { data: [turn] } }),
  })
  const response = await get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'queue', operation: 'start', threadId: thread.id }),
  })
  assert.deepEqual(await response.json(), { turn })
  assert.equal(messages.filter(({ method }) => method === 'thread/resume').length, 1)
  assert.equal(messages.some(({ method }) => method === 'thread/queue/start'), false)
})

test('恢复后队首正在保存时等待原生回显，不启动后一条消息', async t => {
  const thread = { id: 'cold', status: { type: 'notLoaded' } }
  const target = { id: 'first', clientUserMessageId: 'first-message' }
  const turn = { id: 'resumed-turn', items: [{ type: 'userMessage', clientId: target.clientUserMessageId }] }
  let reads = 0
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/queue/list': () => ({ result: { data: [target] } }),
    'thread/resume': () => {
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/queue/start': () => ({ error: { code: -32600, message: 'thread already has an active or pending turn' } }),
    'thread/turns/list': () => ({ result: { data: ++reads === 1 ? [] : [turn] } }),
  })
  const response = await get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'queue', operation: 'start', threadId: thread.id }),
  })
  assert.deepEqual(await response.json(), { turn })
  const starts = messages.filter(({ method }) => method === 'thread/queue/start')
  assert.deepEqual(starts.map(({ params }) => params.queuedSubmissionId), [target.id])
})

test('会话管理只发送批准的原生 RPC，并保留已读版本冲突', async t => {
  const latest = { revision: 'new', firstUnread: { type: 'turn', turnId: 'second' } }
  const { get, messages } = await fakeCodex(t, {
    'thread/readState/update': params => {
      assert.deepEqual(params, { threadId: 'native-thread', expectedRevision: 'visible', operation: { type: 'read' } })
      return { error: { code: -32600, message: 'read state changed', data: { reason: 'readStateConflict', readState: latest } } }
    },
    'thread/name/set': params => {
      assert.deepEqual(params, { threadId: 'native-thread', name: '新标题' })
      return { result: {} }
    },
    'thread/section/move': params => {
      assert.deepEqual(params, { threadId: 'native-thread', sectionId: '01984de2-8f74-7c91-a3b2-5c5e937cf318' })
      return { result: {} }
    },
  })
  const post = (action, value) => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'native-thread', action, ...value }),
  })
  const conflict = await post('read', { expectedRevision: 'visible' })
  assert.equal(conflict.status, 409)
  assert.deepEqual((await conflict.json()).readState, latest)
  assert.equal((await post('rename', { name: '新标题' })).status, 200)
  assert.equal((await post('pin', { pinned: true })).status, 200)
  assert.equal((await post('thread/resume')).status, 400)
  assert.deepEqual(messages.map(message => message.method).filter(method => !/^initialize/.test(method)),
    ['thread/readState/update', 'thread/name/set', 'thread/section/move'])
})

test('会话生命周期使用原生归档、删除和按轮次分支', async t => {
  const source = { id: 'source', cwd: '/mock', status: { type: 'active' } }
  const branch = { id: 'branch', cwd: source.cwd, forkedFromId: source.id }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: source } }),
    'thread/list': ({ archived, ancestorThreadId }) => {
      assert.equal(ancestorThreadId, source.id)
      return { result: { data: archived ? [{ id: 'child', agentNickname: '助手', status: { type: 'active' } }] : [] } }
    },
    'thread/archive': () => ({ result: {} }),
    'thread/unarchive': () => ({ result: { thread: source } }),
    'thread/delete': () => ({ result: {} }),
    'thread/fork': () => ({ result: { thread: branch } }),
  })
  const post = (action, fields) => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: source.id, action, ...fields }),
  })

  const archive = await post('archive')
  assert.equal(archive.status, 409)
  const refusal = await archive.json()
  assert.equal(refusal.reason, 'archiveActive')
  assert.deepEqual(refusal.activity, [{ kind: 'turn' }])
  source.status.type = 'idle'
  const activeChild = await post('archive')
  assert.equal(activeChild.status, 409)
  assert.deepEqual((await activeChild.json()).activity, [{ kind: 'subagent', items: [{ id: 'child', label: '助手' }] }])
  assert.equal((await post('archive', { stopActivity: true })).status, 200)
  assert.equal((await post('unarchive')).status, 200)
  assert.equal((await post('delete')).status, 200)
  assert.equal((await post('fork', { lastTurnId: '' })).status, 400)
  assert.deepEqual((await (await post('fork')).json()).thread, branch)
  assert.deepEqual((await (await post('fork', { lastTurnId: 'earlier', ephemeral: true })).json()).thread, branch)
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/') && method !== 'thread/list').map(({ method, params }) => [method, params]), [
    ['thread/read', { threadId: source.id }],
    ['thread/read', { threadId: source.id }],
    ['thread/archive', { threadId: source.id }],
    ['thread/unarchive', { threadId: source.id }],
    ['thread/delete', { threadId: source.id }],
    ['thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true }],
    ['thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true, lastTurnId: 'earlier' }],
  ])
})

test('回退检查原生线程状态，并以所选轮次为排除边界', async t => {
  const thread = { id: 'source', status: { type: 'active' }, historyMode: 'paginated' }
  let queued = [{ id: 'queued' }]
  let headTurnId = 'latest'
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [{ id: headTurnId }] } }),
    'thread/queue/list': () => ({ result: { data: queued } }),
    'thread/resume': () => {
      thread.status = { type: 'idle' }
      headTurnId = 'concurrent'
      return { result: { thread } }
    },
    'thread/revert': () => ({ result: { thread } }),
  })
  const post = beforeTurnId => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: thread.id, action: 'revert', beforeTurnId, headTurnId: 'latest' }),
  })
  assert.equal((await post(undefined)).status, 400)
  const running = await post('earlier')
  assert.equal(running.status, 409)
  assert.match((await running.json()).error, /停止当前轮次/)
  thread.status.type = 'notLoaded'
  const cold = await post('earlier')
  assert.equal(cold.status, 409)
  assert.match((await cold.json()).error, /待发/)
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
  queued = []
  assert.equal((await post('earlier')).status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/revert'), false)
  headTurnId = 'latest'
  assert.equal((await post('earlier')).status, 200)
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/revert').map(({ params }) => params), [
    { threadId: thread.id, beforeTurnId: 'earlier' },
  ])
  assert.equal(messages.filter(({ method }) => method === 'thread/resume').length, 1)
})

test('归档历史回退先核对目标，再取消归档并检查队列及恢复后的历史', async t => {
  const thread = { id: 'archived-history', historyMode: 'paginated', status: { type: 'notLoaded' } }
  let archived = true
  let head = 'latest'
  let queued = [{ id: 'pending' }]
  let advanceOnResume = false
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': ({ archived: onlyArchived, includedThreadIds }) => ({
      result: { data: archived && onlyArchived && includedThreadIds.includes(thread.id) ? [thread] : [] },
    }),
    'thread/turns/list': () => ({ result: { data: [{ id: head }] } }),
    'thread/items/list': ({ turnId }) => ({ result: { data: turnId === 'earlier' ? [{ item: { id: 'reply' } }] : [] } }),
    'thread/unarchive': () => { archived = false; return { result: { thread } } },
    'thread/queue/list': () => archived ? { error: { code: -32600, message: 'session is archived' } }
      : { result: { data: queued } },
    'thread/resume': () => {
      if (advanceOnResume) head = 'changed'
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/revert': () => ({ result: { thread } }),
  })
  const revert = (fields = {}) => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'revert', threadId: thread.id, beforeTurnId: 'earlier', headTurnId: 'latest', unarchive: true, ...fields,
    }),
  })
  const stale = await revert({ headTurnId: 'stale' })
  assert.equal(stale.status, 409)
  assert.match((await stale.json()).error, /历史已有变化/)
  assert.equal((await revert({ beforeTurnId: 'missing' })).status, 409)
  assert.equal(messages.some(({ method }) => ['thread/unarchive', 'thread/resume', 'thread/revert'].includes(method)), false)

  const pending = await revert()
  assert.equal(pending.status, 409)
  assert.match((await pending.json()).error, /待发/)
  assert.equal(archived, false)
  assert.equal(messages.some(({ method }) => ['thread/resume', 'thread/revert'].includes(method)), false)

  queued = []
  advanceOnResume = true
  assert.equal((await revert()).status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/revert'), false)

  head = 'latest'
  assert.equal((await revert()).status, 200)
  assert.deepEqual(messages.filter(({ method }) => ['thread/unarchive', 'thread/resume', 'thread/revert'].includes(method))
    .map(({ method }) => method), ['thread/unarchive', 'thread/resume', 'thread/revert'])
})

test('归档旧消息重发前确认草稿模型和权限，原生顺序保持先回退后发送', async t => {
  const thread = { id: 'archived-edit', cwd: '/workspace', historyMode: 'paginated', status: { type: 'notLoaded' },
    model: 'old', modelProvider: 'openai' }
  const profile = ':read-only'
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [{ id: 'latest' }] } }),
    'thread/items/list': () => ({ result: { data: [{ item: { id: 'original', type: 'userMessage',
      content: [{ type: 'text', text: 'Original', text_elements: [] }] } }] } }),
    'permissionProfile/list': () => ({ result: { data: [{ id: profile, allowed: true }] } }),
    'thread/list': () => ({ result: { data: [thread] } }),
    'thread/unarchive': () => ({ result: { thread } }),
    'thread/queue/list': () => ({ result: { data: [] } }),
    'thread/resume': ({ model, config, permissions }) => {
      thread.status = { type: 'idle' }
      thread.model = model
      thread.reasoningEffort = config?.model_reasoning_effort
      return { result: { thread, activePermissionProfile: { id: permissions } } }
    },
    'thread/revert': () => ({ result: { thread } }),
    'turn/start': () => {
      thread.status = { type: 'active' }
      return { result: { turn: { id: 'replacement' } } }
    },
  })
  const edited = await get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'edit', unarchive: true, threadId: thread.id, beforeTurnId: 'earlier', headTurnId: 'latest', itemId: 'original', text: 'Edited',
      modelDraft: { provider: 'openai', model: 'selected', reasoningEffort: 'high' }, permissionDraft: profile,
    }),
  })
  assert.equal(edited.status, 200)
  assert.equal((await edited.json()).permission?.profileId, profile)
  const transitions = messages.filter(({ method }) => ['thread/unarchive', 'thread/resume', 'thread/revert', 'turn/start'].includes(method))
  assert.deepEqual(transitions.map(({ method }) => method), ['thread/unarchive', 'thread/resume', 'thread/revert', 'turn/start'])
  assert.deepEqual(transitions[1].params, { threadId: thread.id, excludeTurns: true, model: 'selected',
    config: { model_reasoning_effort: 'high' }, permissions: profile })
  assert.equal(transitions[3].params.input[0].text, 'Edited')
})

test('首次发送等到草稿模型已应用再进入原生队列', async t => {
  const thread = { id: 'cold', modelProvider: 'original', model: 'previous', status: { type: 'notLoaded' } }
  let modelReads = 0
  let updating = false
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => {
      if (updating && ++modelReads === 2) Object.assign(thread, { model: 'selected', reasoningEffort: 'high' })
      return { result: { thread } }
    },
    'thread/resume': () => {
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/settings/update': ({ model, effort }) => {
      assert.equal(model, 'selected')
      assert.equal(effort, 'high')
      updating = true
      return { result: {} }
    },
    'thread/queue/add': () => ({ result: { model: thread.model, effort: thread.reasoningEffort } }),
  })
  const post = provider => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'prompt', mode: 'queue', threadId: thread.id, clientUserMessageId: 'draft',
      input: [{ type: 'text', text: 'prompt' }], modelDraft: { provider, model: 'selected', reasoningEffort: 'high' } }),
  })
  assert.equal((await post('other')).status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
  assert.deepEqual(await (await post('original')).json(), { model: 'selected', effort: 'high' })
  assert.deepEqual(messages.map(({ method }) => method).filter(method => ['thread/resume', 'thread/settings/update', 'thread/queue/add'].includes(method)),
    ['thread/resume', 'thread/settings/update', 'thread/queue/add'])
})

test('编辑原生用户消息保留附件，回退后才发送，且只接受轮首消息', async t => {
  const image = { type: 'localImage', path: '/workspace/illustration.png' }
  const mention = { type: 'mention', name: 'example', path: '/workspace/example.txt' }
  const thread = { id: 'source', status: { type: 'idle' }, historyMode: 'paginated' }
  let rejectSend = false
  let content = [image, { type: 'text', text: 'original', text_elements: [] }, mention]
  const { get, messages } = await fakeCodex(t, {
    'thread/items/list': ({ turnId }) => {
      assert.equal(turnId, 'selected')
      return { result: { data: [{ item: { type: 'userMessage', id: 'opening', content } },
        { item: { type: 'userMessage', id: 'later', content: [] } }] } }
    },
    'thread/turns/list': () => ({ result: { data: [{ id: 'latest' }] } }),
    'thread/read': () => ({ result: { thread } }),
    'thread/revert': () => ({ result: { thread } }),
    'turn/start': () => rejectSend ? { error: { code: -32600, message: 'Native provider offline' } } : { result: { turn: { id: 'replacement' } } },
  })
  const edit = (itemId, headTurnId = 'latest') => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'edit', threadId: thread.id, beforeTurnId: 'selected', itemId, headTurnId, text: 'edited\nmessage' }),
  })
  assert.equal((await edit('later')).status, 400)
  assert.equal((await edit('opening', 'stale')).status, 409)
  assert.deepEqual((await (await edit('opening')).json()).turn, { id: 'replacement' })
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/revert' || method === 'turn/start').map(({ method, params }) => [method, params]), [
    ['thread/revert', { threadId: thread.id, beforeTurnId: 'selected' }],
    ['turn/start', { threadId: thread.id, input: [image, { type: 'text', text: 'edited\nmessage', text_elements: [] }, mention] }],
  ])
  rejectSend = true
  const failed = await edit('opening')
  assert.equal(failed.status, 409)
  assert.match((await failed.json()).error, /历史已回退.*Native provider offline/)
  content = [{ type: 'text', text:
    '<send_user_message_question_reply>{"questionItemId":"one","question":"Which environment?","answer":"Staging"}</send_user_message_question_reply>' }]
  assert.equal((await edit('opening')).status, 400)
  assert.equal(messages.filter(({ method }) => method === 'thread/revert').length, 2)
})

test('历史编辑按恢复后的工作目录确认技能，再沿用回退与重发', async t => {
  const thread = { id: 'skill-edit', cwd: '/saved', status: { type: 'notLoaded' }, historyMode: 'paginated' }
  const text = { type: 'text', text: '请用 $review', text_elements: [] }
  const old = { type: 'skill', name: 'review', path: '/previous/review/SKILL.md' }
  const current = { ...old, path: '/current/review/SKILL.md' }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/queue/list': () => ({ result: { data: [] } }),
    'thread/resume': () => {
      thread.cwd = '/current'
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/turns/list': () => ({ result: { data: [{ id: 'turn' }] } }),
    'thread/items/list': () => ({ result: { data: [{ item: { id: 'opening', type: 'userMessage',
      content: [{ ...text, text: '早先用 $review' }, old] } }] } }),
    'skills/list': ({ cwds }) => ({ result: { data: [{ cwd: cwds[0], skills: [{ ...current,
      path: `${cwds[0]}/review/SKILL.md`, enabled: true }], errors: [] }] } }),
    'thread/revert': () => ({ result: { thread } }),
    'turn/start': () => {
      thread.status = { type: 'active' }
      return { result: { turn: { id: 'replacement' } } }
    },
  })
  const result = await get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'edit', threadId: thread.id, beforeTurnId: 'turn', headTurnId: 'turn', itemId: 'opening', text: text.text,
    }),
  })
  assert.equal(result.status, 200)
  assert.deepEqual(messages.filter(({ method }) => ['skills/list', 'thread/revert', 'turn/start'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['skills/list', { cwds: [thread.cwd] }], ['thread/revert', { threadId: thread.id, beforeTurnId: 'turn' }],
    ['turn/start', { threadId: thread.id, input: [text, current] }],
  ])
})

test('模型目录逐页读取各 Codex provider 的原生模型和等级', async t => {
  const model = (id, isDefault, effort) => ({ id, model: id, displayName: id, isDefault, defaultReasoningEffort: effort,
    supportedReasoningEfforts: [{ reasoningEffort: effort, description: '原生等级' }] })
  const { get, messages } = await fakeCodex(t, {
    'modelProvider/list': () => ({ result: { data: [{ id: 'first', name: '原生 provider' }, { id: 'unavailable', name: '离线' }], defaultProviderId: 'first' } }),
    'model/list': ({ modelProvider, cursor }) => modelProvider === 'unavailable'
      ? { error: { code: -32600, message: 'unavailable' } }
      : { result: cursor ? { data: [model('other', false, 'low')], nextCursor: null }
        : { data: [model('native', true, 'high')], nextCursor: 'more' } },
  })
  const response = await get('/api/codex/models')
  assert.equal(response.status, 200)
  const catalog = await response.json()
  assert.deepEqual(catalog.default, { provider: 'first', model: 'native', reasoningEffort: 'high' })
  assert.deepEqual(catalog.groups[0].models.map(({ id, reasoning }) => [id, reasoning.defaultEffort]), [['native', 'high'], ['other', 'low']])
  assert.deepEqual(catalog.failures.map(group => group.id), ['unavailable'])
  assert.equal(messages.some(message => message.method === 'thread/resume'), false)
})

test('模型选择只修改同一 provider 的后续轮次设置，并读取接受后的选择', async t => {
  let model = 'previous'
  let status = 'active'
  let queued = false
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'native-thread', model, modelProvider: 'original', reasoningEffort: 'high', status: { type: status } } } }),
    'thread/settings/update': params => {
      assert.deepEqual(params, { threadId: 'native-thread', model: 'selected', effort: 'high' })
      if (!queued) model = params.model
      return { result: {} }
    },
  })
  const post = provider => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'model', threadId: 'native-thread', provider, model: 'selected', reasoningEffort: 'high', cwd: '/ignored' }),
  })
  assert.equal((await post('different')).status, 409)
  assert.deepEqual(await (await post('original')).json(), { selection: { provider: 'original', model: 'selected', reasoningEffort: 'high' } })
  status = 'notLoaded'
  assert.equal((await post('original')).status, 409)
  status = 'active'
  model = 'previous'
  queued = true
  assert.deepEqual(await (await post('original')).json(), {})
  assert.equal(messages.filter(message => message.method === 'thread/settings/update').length, 2)
  assert.equal(messages.some(message => ['thread/resume', 'turn/start', 'turn/settings/update'].includes(message.method)), false)
})

test('通过原生目录筛选分页，保留线程 ID 和原始时间', async t => {
  const thread = { id: 'original-thread', cwd: '/projects/example', updatedAt: 1234, projectId: null }
  const { get, messages } = await fakeCodex(t, {
    'thread/list': params => {
      assert.deepEqual(params, { limit: 60, sortKey: 'updated_at', modelProviders: [], cwd: thread.cwd, cursor: 'previous+page' })
      return { result: { data: [thread], nextCursor: 'next' } }
    },
  })
  const result = await get('/api/codex/threads?cwd=%2Fprojects%2Fexample&cursor=previous%2Bpage')
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { data: [thread], nextCursor: 'next' })
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'thread/list'])
})

test('归档浏览按 Codex 原生归档分页保留原会话 ID', async t => {
  const { get, messages } = await fakeCodex(t, {
    'thread/list': ({ archived, cursor }) => {
      assert.equal(archived, true)
      return { result: cursor
        ? { data: [{ id: 'second' }], nextCursor: null }
        : { data: [{ id: 'first' }], nextCursor: 'native-next' } }
    },
  })
  const response = await get('/api/codex/archived')
  assert.deepEqual(await response.json(), { threads: [{ id: 'first', archived: true }, { id: 'second', archived: true }], workspacePaths: {} })
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'thread/list', 'thread/list'])
})

test('按父线程读取 Codex 子代理，不走全局清单', async t => {
  const child = { id: 'native-child', parentThreadId: 'native-parent', agentNickname: 'Scout' }
  const { get } = await fakeCodex(t, {
    'thread/list': params => {
      assert.deepEqual(params, {
        limit: 100, modelProviders: [], sortKey: 'updated_at', parentThreadId: 'native-parent',
        sourceKinds: ['subAgent'], useStateDbOnly: true,
      })
      return { result: { data: [child], nextCursor: null } }
    },
  })
  const response = await get('/api/codex/children?threadId=native-parent')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [child])
})

test('按原生 ID 查找归档子会话时保留归档标记', async t => {
  const thread = { id: 'archived-child', source: { subAgent: { thread_spawn: { parent_thread_id: 'native-parent' } } } }
  const { get } = await fakeCodex(t, {
    'thread/read': ({ threadId }) => {
      assert.equal(threadId, thread.id)
      return { result: { thread } }
    },
    'thread/list': ({ parentThreadId, sourceKinds, archived }) => {
      assert.equal(parentThreadId, 'native-parent')
      assert.deepEqual(sourceKinds, ['subAgent'])
      assert.equal(archived, true)
      return { result: { data: [thread] } }
    },
  })
  const response = await get(`/api/codex/thread-summary?threadId=${thread.id}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { thread: { ...thread, archived: true } })
})

test('正文搜索使用 Codex 返回的会话、片段和游标', async t => {
  const thread = { id: 'older-thread', cwd: '/projects/older' }
  const result = { data: [{ thread, snippet: '正文里的命中' }], nextCursor: 'more' }
  const { get, messages } = await fakeCodex(t, {
    'thread/search': params => {
      assert.deepEqual(params, { searchTerm: '命中', sortKey: 'updated_at', limit: 20, archived: true, cursor: 'native+page' })
      return { result }
    },
  })
  const response = await get('/api/codex/search?searchTerm=%E5%91%BD%E4%B8%AD&archived=1&cursor=native%2Bpage')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ...result, workspacePaths: {} })
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'thread/search'])
})

test('会话内搜索保留 Codex 原生消息和轮次定位', async t => {
  const hit = { itemId: 'item', turnId: 'turn', turnCursor: 'native-turn-cursor', snippet: '原文', snippetMatchRange: { start: 0, end: 2 } }
  const { get } = await fakeCodex(t, {
    'thread/searchOccurrences': params => {
      assert.equal(params.threadId, 'original-thread')
      assert.equal(params.searchTerm, '原文')
      return { result: { data: [hit], nextCursor: null } }
    },
  })
  const response = await get('/api/codex/search-occurrences?threadId=original-thread&searchTerm=%E5%8E%9F%E6%96%87')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { data: [hit], nextCursor: null })
})

test('按原生 ID 读取轮次，浏览历史时不会恢复线程', async t => {
  const turn = { id: 'original-turn', startedAt: 123, items: [{ id: 'item', type: 'agentMessage', text: '原文' }] }
  const { get, messages, clientClosed } = await fakeCodex(t, {
    'thread/turns/list': params => {
      assert.deepEqual(params, { threadId: 'original-thread', limit: 25, sortDirection: 'desc', itemsView: 'full', cursor: 'older' })
      return { result: { data: [turn], nextCursor: null } }
    },
  })
  const result = await get('/api/codex/turns?threadId=original-thread&cursor=older')
  assert.deepEqual(await result.json(), { data: [turn], nextCursor: null })
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'thread/turns/list'])
  await clientClosed
})

test('向已连接的 daemon 查询原生项目', async t => {
  const project = { id: 'original-project', name: '测试项目', roots: [{ path: '/xyz' }] }
  const { get, messages } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [project], nextCursor: null } }),
  })
  const result = await get('/api/codex/projects')
  assert.deepEqual(await result.json(), { data: [project], nextCursor: null })
  assert.equal(messages[0].params.capabilities.experimentalApi, true)
})

test('会话详情保留 Codex 的模型设置和 Goal，两个读取共用连接', async t => {
  const goal = { threadId: 'native', objective: '已有目标', status: 'paused', tokensUsed: 500 }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'native', model: 'native-model', reasoningEffort: 'high' } } }),
    'thread/goal/get': () => ({ result: { goal } }),
  })
  assert.deepEqual(await (await get('/api/codex/thread-info?threadId=native')).json(), {
    model: 'native-model', reasoningEffort: 'high', goal,
  })
  assert.deepEqual(messages.map(message => message.method).sort(), ['initialize', 'initialized', 'thread/read', 'thread/goal/get'].sort())
})

test('会话详情分页读取已加载线程的原生后台终端', async t => {
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'native', status: { type: 'idle' } } } }),
    'thread/backgroundTerminals/list': params => {
      assert.equal(params.threadId, 'native')
      return { result: params.cursor
        ? { data: [{ processId: 'second', command: 'second', cwd: '/repo' }], nextCursor: null }
        : { data: [{ processId: 'first', command: 'first', cwd: '/repo' }], nextCursor: 'next' } }
    },
  })
  const info = await (await get('/api/codex/thread-info?threadId=native')).json()
  assert.equal(info.goal, null)
  assert.deepEqual(info.terminals.map(terminal => terminal.processId), ['first', 'second'])
  assert.equal(messages.some(message => message.method === 'thread/resume'), false)
})

test('/ps 将尚未加载或查询时卸载的会话显示为空列表', async t => {
  let unloading = 'idle'
  const { get, messages } = await fakeCodex(t, {
    'thread/read': ({ threadId }) => ({ result: { thread: {
      id: threadId, status: { type: threadId === 'cold' ? 'notLoaded' : unloading },
    } } }),
    'thread/backgroundTerminals/list': ({ threadId }) => {
      assert.equal(threadId, 'unloading')
      unloading = 'notLoaded'
      return { error: { code: -32600, message: 'thread not found: unloading' } }
    },
  })
  const cold = await get('/api/codex/thread-info?threadId=cold&view=ps')
  assert.equal(cold.status, 200)
  assert.deepEqual((await cold.json()).terminals, [])
  const interrupted = await get('/api/codex/thread-info?threadId=unloading&view=ps')
  assert.equal(interrupted.status, 200)
  assert.deepEqual((await interrupted.json()).terminals, [])
  assert.deepEqual(messages.filter(message => message.params?.threadId).map(message => message.method),
    ['thread/read', 'thread/read', 'thread/backgroundTerminals/list', 'thread/read'])
})

test('/ps 在 App Server 不支持进程查询时报告列表不可用', async t => {
  const { get } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'loaded', status: { type: 'idle' } } } }),
  })
  const response = await get('/api/codex/thread-info?threadId=loaded&view=ps')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).terminals, null)
})

async function watchBackgroundTerminals(t, get) {
  const response = await get('/api/codex/watch?scope=catalog&backgroundTerminals=1')
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const decoder = new TextDecoder()
  async function next(type) {
    for (;;) {
      const { value, done } = await reader.read()
      assert.equal(done, false, `等待 ${type} 时目录流关闭`)
      const event = decoder.decode(value)
      if (!event.startsWith('data: ')) continue
      const frame = JSON.parse(event.slice(6))
      if (frame.type === type) return frame
    }
  }
  await next('catalog-ready')
  return { next: () => next('background-terminals'), close: () => reader.cancel() }
}

test('多个目录连接共用后台进程扫描，进程自然退出后自动更新', { timeout: 4000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminal = { processId: '42', command: 'sleep 60', cwd: '/repo' }
  let idleRows = [terminal]
  const { get, messages } = await fakeCodex(t, {
    'thread/loaded/list': ({ cursor }) => ({ result: cursor
      ? { data: ['idle'] } : { data: ['quiet'], nextCursor: 'second-page' } }),
    'thread/backgroundTerminals/list': ({ threadId }) => ({ result: { data: threadId === 'idle' ? idleRows : [] } }),
  })
  const [first, second] = await Promise.all([watchBackgroundTerminals(t, get), watchBackgroundTerminals(t, get)])
  const initial = { type: 'background-terminals', byThread: { idle: [terminal] } }
  assert.deepEqual(await Promise.all([first.next(), second.next()]), [initial, initial])
  assert.equal(messages.filter(({ method }) => method === 'thread/loaded/list').length, 2)
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/backgroundTerminals/list')
    .map(({ params }) => params.threadId).sort(), ['idle', 'quiet'])

  idleRows = []
  await new Promise(setImmediate)
  t.mock.timers.tick(10_000)
  const empty = { type: 'background-terminals', byThread: {} }
  assert.deepEqual(await Promise.all([first.next(), second.next()]), [empty, empty])
  assert.equal(messages.filter(({ method }) => method === 'thread/loaded/list').length, 4)

  await Promise.all([first.close(), second.close()])
  t.mock.timers.tick(20_000)
  idleRows = [terminal]
  await new Promise(setImmediate)
  assert.equal(messages.filter(({ method }) => method === 'thread/loaded/list').length, 4)
  const reconnected = await watchBackgroundTerminals(t, get)
  assert.deepEqual(await reconnected.next(), initial)
  assert.equal(messages.filter(({ method }) => method === 'thread/loaded/list').length, 6)
  assert.equal(messages.some(({ method }) => method === 'thread/resume' || method === 'thread/read'), false)
})

test('从网页确认停止一个后台进程后，目录流立即保留其余进程', { timeout: 4000 }, async t => {
  const target = { processId: '42', command: 'sleep 60', cwd: '/repo' }
  const kept = { processId: '43', command: 'sleep 90', cwd: '/repo' }
  let rows = [target, kept]
  const { get, messages } = await fakeCodex(t, {
    'thread/loaded/list': () => ({ result: { data: ['thread'] } }),
    'thread/backgroundTerminals/list': () => ({ result: { data: rows } }),
    'thread/backgroundTerminals/terminate': params => {
      assert.deepEqual(params, { threadId: 'thread', processId: target.processId })
      const terminated = rows.includes(target)
      rows = [kept]
      return { result: { terminated } }
    },
  })
  const { next } = await watchBackgroundTerminals(t, get)
  const stop = () => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'terminate-background-terminal', threadId: 'thread', processId: target.processId }),
  })
  assert.deepEqual((await next()).byThread, { thread: [target, kept] })
  const stopped = await stop()
  assert.equal(stopped.status, 200)
  assert.deepEqual(await stopped.json(), { terminated: true })
  assert.deepEqual((await next()).byThread, { thread: [kept] })
  assert.deepEqual(await (await stop()).json(), { terminated: false })
  assert.equal(messages.some(({ method }) => method === 'turn/interrupt' || method === 'thread/resume'), false)
})

test('已淘汰的分页游标返回上游错误', async t => {
  const { get } = await fakeCodex(t, {
    'thread/turns/list': () => ({ error: { code: -32602, message: 'invalid cursor' } }),
  })
  const result = await get('/api/codex/turns?threadId=original-thread&cursor=stale')
  assert.equal(result.status, 400)
  assert.deepEqual(await result.json(), { error: 'invalid cursor' })
})

test('已取消的读取不会打开 socket 或留下未捕获错误', async () => {
  const socketPath = join(process.cwd(), '.runtime', 'absent-app-server.sock')
  await assert.rejects(
    readCodex('thread/list', {}, socketPath, AbortSignal.abort()),
    { name: 'AbortError' },
  )
})

test('先发布索引项目，完整清单共享一次扫描，后台补齐旧目录', async t => {
  const indexed = { id: 'indexed', cwd: '/projects/new' }
  const legacy = { id: 'legacy', cwd: '/projects/old' }
  const { get, messages } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [], nextCursor: null } }),
    'thread/list': params => {
      if (params.useStateDbOnly) return { result: { data: [indexed], nextCursor: null } }
      return { result: params.cursor
        ? { data: [indexed, legacy], nextCursor: null }
        : { data: [indexed], nextCursor: 'page-two' } }
    },
  })
  const index = await (await get('/api/codex/catalog')).json()
  assert.deepEqual(index, { projects: [], threads: [indexed], workspacePaths: {}, complete: false })
  const both = await Promise.all([get('/api/codex/catalog?complete=1'), get('/api/codex/catalog?complete=1')])
  const expected = { projects: [], threads: [indexed, legacy], workspacePaths: {}, complete: true }
  assert.deepEqual(await both[0].json(), expected)
  assert.deepEqual(await both[1].json(), expected)
  assert.deepEqual(await (await get('/api/codex/catalog')).json(), expected)
  assert.deepEqual(messages.filter(m => m.method === 'thread/list').map(m => m.params.cursor), [
    undefined, undefined, 'page-two',
  ])
  assert.equal(messages.filter(m => m.method === 'initialize').length, 2)
  assert.equal(messages.some(m => m.method.startsWith('thread/turns')), false)
})

test('原生清单保留跨页已读和未读位置', async t => {
  const unread = { firstUnread: { type: 'turn', turnId: 'answer' }, revision: 'first' }
  const read = { firstUnread: null, revision: 'second' }
  const { get } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [], nextCursor: null } }),
    'thread/list': ({ cursor }) => ({ result: cursor
      ? { data: [{ id: 'read' }], readStates: { read }, nextCursor: null }
      : { data: [{ id: 'unread' }], readStates: { unread }, nextCursor: 'page-two' } }),
  })
  const { threads } = await (await get('/api/codex/catalog?complete=1')).json()
  assert.deepEqual(threads, [{ id: 'unread', readState: unread }, { id: 'read', readState: read }])
})

test('Host 重启可以先返回磁盘清单，随后重新从 Codex 确认', async t => {
  let thread = { id: 'original', name: '旧标题', cwd: '/projects/example', status: { type: 'active' } }
  const { socketPath, directory, messages } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [], nextCursor: null } }),
    'thread/list': () => ({ result: { data: [thread], nextCursor: null } }),
  })
  function newHost() {
    const route = createHistoryRoutes(socketPath, undefined, join(directory, 'cache'))
      .find(route => route.path === '/api/codex/catalog')
    return async query => (await route.fetch(new Request(`http://localhost${route.path}${query}`))).json()
  }

  const first = await newHost()('?complete=1')
  assert.equal(first.complete, true)
  assert.equal(messages.filter(m => m.method === 'thread/list').length, 1)
  thread = { ...thread, name: 'Codex 的新标题' }

  const restarted = newHost()
  const warm = await restarted('')
  assert.equal(warm.complete, false)
  assert.deepEqual(warm.threads, [{ id: 'original', name: '旧标题', cwd: '/projects/example' }])
  assert.equal(messages.filter(m => m.method === 'thread/list').length, 1)
  const refreshed = await restarted('?complete=1')
  assert.equal(refreshed.threads[0].name, 'Codex 的新标题')
  assert.equal(messages.filter(m => m.method === 'thread/list').length, 2)
})

test('首屏刷新直接纳入索引新会话与尚未保存的已加载会话', async t => {
  const legacy = { id: 'legacy', cwd: '/work', historyMode: 'rollout' }
  const saved = { id: 'saved', cwd: '/work', historyMode: 'paginated', preview: '原生首条消息' }
  const unsent = { id: 'unsent', cwd: '/work', source: 'vscode', historyMode: 'paginated', preview: '', status: { type: 'idle' } }
  const hidden = { id: 'hidden', cwd: '/work', ephemeral: true }
  let indexed = []
  let loaded = []
  const { socketPath, directory, messages } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [], nextCursor: null } }),
    'thread/list': ({ useStateDbOnly }) => ({ result: { data: useStateDbOnly ? indexed : [...indexed, legacy], nextCursor: null } }),
    'thread/loaded/list': () => ({ result: { data: loaded, nextCursor: null } }),
    'thread/read': ({ threadId }) => ({ result: { thread: threadId === unsent.id ? unsent : hidden } }),
  })
  function newHost() {
    const route = createHistoryRoutes(socketPath, undefined, join(directory, 'cache'))
      .find(route => route.path === '/api/codex/catalog')
    return async query => (await route.fetch(new Request(`http://localhost${route.path}${query}`))).json()
  }
  const host = newHost()
  assert.deepEqual((await host('?complete=1')).threads, [legacy])
  indexed = [saved]
  loaded = [saved.id, unsent.id, hidden.id]
  assert.deepEqual((await host('?fresh=1')).threads, [saved, { ...unsent, blank: true }, legacy])
  assert.deepEqual((await host('?complete=1&fresh=1')).threads, [saved, legacy, { ...unsent, blank: true }])
  assert.equal((await newHost()('')).threads.some(thread => thread.id === unsent.id), false)
  assert.equal(messages.some(message => message.method === 'thread/resume'), false)
})

test('Codex 状态库不可用时仍可从原生历史读取工作区', async t => {
  const legacy = { id: 'legacy', cwd: '/projects/old' }
  const { get } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [], nextCursor: null } }),
    'thread/list': ({ useStateDbOnly }) => (useStateDbOnly
      ? { error: { code: -32603, message: 'state database unavailable' } }
      : { result: { data: [legacy], nextCursor: null } }),
  })
  const response = await get('/api/codex/catalog')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { projects: [], threads: [legacy], workspacePaths: {}, complete: true })
})

test('缓存过期后的完整刷新失败，不会让已显示的旧工作区退回索引子集', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  let offline = false
  const indexed = { id: 'indexed', cwd: '/projects/new' }
  const legacy = { id: 'legacy', cwd: '/projects/old' }
  const { get } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [], nextCursor: null } }),
    'thread/list': ({ useStateDbOnly }) => {
      if (useStateDbOnly) return { result: { data: [indexed], nextCursor: null } }
      return offline
        ? { error: { code: -32603, message: 'history unavailable' } }
        : { result: { data: [indexed, legacy], nextCursor: null } }
    },
  })
  await get('/api/codex/catalog?complete=1')
  offline = true
  t.mock.timers.tick(60_001)

  const cached = await (await get('/api/codex/catalog')).json()
  assert.deepEqual(cached.threads, [indexed, legacy])
  assert.equal(cached.complete, false)
  assert.equal((await get('/api/codex/catalog?complete=1')).status, 502)
  assert.deepEqual((await (await get('/api/codex/catalog')).json()).threads, [indexed, legacy])
})

test('只读 SSE 在原生历史变更后推送增量和状态，且不恢复线程', { timeout: 5000 }, async t => {
  const threadId = 'observed'
  const head = { id: 'round', status: 'inProgress', items: [] }
  const old = { id: 'first', type: 'agentMessage', text: '原有', completedAtMs: 1000 }
  const fresh = { id: 'second', type: 'agentMessage', text: '新增', completedAtMs: 2000 }
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status: { type: 'active', activeFlags: [] }, historyMode: 'paginated' } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': ({ itemsView }) => ({
      result: { data: [itemsView === 'full' ? { ...head, items: [old] } : head], backwardsCursor: 'head' },
    }),
    'thread/items/list': () => ({ result: { data: [{ item: fresh, turnId: head.id, completedAtMs: 2000 }] } }),
  })
  const response = await fixture.get(`/api/codex/watch?threadId=${threadId}`)
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
  const reader = response.body.getReader()
  const read = async () => {
    const { done, value } = await reader.read()
    assert.equal(done, false)
    return JSON.parse(new TextDecoder().decode(value).slice(6))
  }
  const snapshot = await read()
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.mode, 'live')
  const waiting = { type: 'active', activeFlags: ['waitingOnUserInput'] }
  fixture.broadcast({ id: 'request', method: 'item/tool/requestUserInput', params: { threadId } })
  fixture.broadcast({ method: 'thread/status/changed', params: { threadId, status: waiting } })
  const state = await read()
  assert.deepEqual(state.notification.params.status, waiting)
  await writeFile(join(fixture.directory, 'thread_history_1.sqlite-wal'), 'write notification')
  const change = await read()
  assert.equal(change.type, 'change')
  assert.deepEqual(change.items.map(item => item.id), ['second'])
  const allowed = new Set(['initialize', 'initialized', 'thread/read', 'config/read', 'thread/turns/list', 'thread/items/list'])
  assert.equal(fixture.messages.every(message => allowed.has(message.method)), true)
  assert.equal(fixture.messages[0].params.clientInfo.name, 'codex_app_server_daemon')
  await reader.cancel()
  await fixture.clientClosed
})

test('SSE 重连沿用先前的条目游标，回放初始快照之外的较早活动', { timeout: 5000 }, async t => {
  const threadId = 'root'
  const latest = { id: 'latest', status: 'completed', items: [] }
  const late = { id: 'done', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child', agentPath: '/root/review' }
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, historyMode: 'paginated' } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: [latest] } }),
    'thread/items/list': ({ sortDirection, cursor }) => ({
      result: sortDirection === 'desc' ? { data: [], backwardsCursor: 'after-activity' }
        : { data: cursor === 'before-disconnect' ? [{ turnId: 'older', item: late }] : [] },
    }),
  })
  const response = await fixture.get(`/api/codex/watch?threadId=${threadId}`, { headers: { 'Last-Event-ID': 'before-disconnect' } })
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const read = async () => new TextDecoder().decode((await reader.read()).value)
  assert.equal(JSON.parse((await read()).slice(6)).type, 'snapshot')
  assert.deepEqual(JSON.parse((await read()).slice(6)), { type: 'change', turn: { id: 'older' }, items: [late], onlyIfLoaded: true })
  assert.match(await read(), /^id: after-activity\nevent: history-checkpoint/)
})

test('原生未读只推送变化，其他会话的已读更新无需刷新对话或清单', { timeout: 5000 }, async t => {
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'selected' }, readState: { firstUnread: null, revision: 'one' } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
  })
  const db = new DatabaseSync(join(fixture.directory, 'state_5.sqlite'))
  t.after(() => db.close())
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE thread_read_receipts (thread_id TEXT PRIMARY KEY, first_unread_turn TEXT);
    INSERT INTO thread_read_receipts VALUES ('other', 'previous-turn');`)
  const response = await fixture.get('/api/codex/watch?scope=catalog')
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.deepEqual(await read(), { type: 'catalog-ready' })
  assert.deepEqual(await read(), { type: 'unread', replace: true, added: ['other'], removed: [] })
  db.exec(`UPDATE thread_read_receipts SET first_unread_turn = NULL WHERE thread_id = 'other';
    INSERT INTO thread_read_receipts VALUES ('new', '');`)
  assert.deepEqual(await read(), { type: 'unread', replace: false, added: ['new'], removed: ['other'] })
  assert.deepEqual(fixture.messages.map(message => message.method).sort(),
    ['initialize', 'initialized', 'config/read'].sort())
  await reader.cancel()
})

test('取消归档通知后重连历史流以读取移动后的原生记录', { timeout: 2000 }, async t => {
  const threadId = 'moving-rollout'
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, historyMode: 'paginated' } } }),
    'thread/turns/list': () => ({ result: { data: [], nextCursor: null } }),
  })
  const reader = (await fixture.get(`/api/codex/watch?threadId=${threadId}`)).body.getReader()
  t.after(() => reader.cancel())
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.equal((await read()).type, 'snapshot')
  fixture.broadcast({ method: 'thread/unarchived', params: { threadId } })
  assert.equal((await read()).notification.method, 'thread/unarchived')
  assert.equal((await reader.read()).done, true)
})

test('回退通知在同一 SSE 连接替换历史尾部和游标', { timeout: 5000 }, async t => {
  const threadId = 'observed'
  const kept = { id: 'kept', status: 'completed', items: [] }
  let turns = [{ ...kept, id: 'removed' }, kept]
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, historyMode: 'paginated' } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: turns, nextCursor: turns[0].id } }),
  })
  const response = await fixture.get(`/api/codex/watch?threadId=${threadId}`)
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.equal((await read()).page.nextCursor, 'removed')

  turns = [kept]
  fixture.broadcast({ method: 'thread/reverted', params: { threadId } })
  const snapshot = await read()
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.replace, true)
  assert.deepEqual(snapshot.page, { data: [kept], nextCursor: 'kept' })
  assert.equal(fixture.messages.filter(({ method }) => method === 'initialize').length, 1)
  await reader.cancel()
})

test('网页从原生队列变更推送只读队列快照，并保持线程未加载', { timeout: 5000 }, async t => {
  const threadId = 'stored'
  const queued = { id: 'native-id', clientUserMessageId: 'browser-input', input: [{ type: 'text', text: '等下一轮' }] }
  let entries = []
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status: { type: 'notLoaded' } } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => ({ result: { data: entries, nextCursor: null } }),
  })
  const response = await fixture.get(`/api/codex/watch?threadId=${threadId}&queue=1`)
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.equal((await read()).status.type, 'notLoaded')
  assert.deepEqual(await read(), { type: 'queue', submissions: [] })
  entries = [queued]
  await writeFile(join(fixture.directory, 'queue_1.sqlite-wal'), 'native queue mutation')
  assert.deepEqual(await read(), { type: 'queue', submissions: [queued] })
  assert.equal(fixture.messages.some(({ method }) => method === 'thread/resume' || method === 'thread/queue/start'), false)
  await reader.cancel()
})

test('等待首条消息的原生新会话可以打开为空历史', { timeout: 5000 }, async t => {
  const threadId = 'fresh'
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status: { type: 'idle' }, historyMode: 'paginated' } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ error: { code: -32600,
      message: `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`,
    } }),
  })
  const history = await fixture.get(`/api/codex/turns?threadId=${threadId}`)
  assert.equal(history.status, 200)
  assert.deepEqual((await history.json()).data, [])
  const reader = (await fixture.get(`/api/codex/watch?threadId=${threadId}`)).body.getReader()
  const snapshot = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.equal(snapshot.status.type, 'idle')
  assert.deepEqual(snapshot.page.data, [])
  await reader.cancel()
})

test('首条消息写入时，正在运行的新会话推送 Codex 原生预览', { timeout: 5000 }, async t => {
  const threadId = 'first-run'
  const status = { type: 'active', activeFlags: [] }
  const turn = { id: 'initial-turn', status: 'inProgress', items: [] }
  const input = { id: 'first-input', type: 'userMessage', content: [{ type: 'text', text: '第一条原生消息' }] }
  let saved = false
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status, historyMode: 'paginated',
      preview: saved ? '第一条原生消息' : '', name: null,
    } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: saved ? [turn] : [] } }),
    'thread/items/list': () => ({ result: { data: [{ item: input }] } }),
  })
  const reader = (await fixture.get(`/api/codex/watch?threadId=${threadId}`)).body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.equal((await read()).type, 'snapshot')
  saved = true
  await writeFile(join(fixture.directory, 'thread_history_1.sqlite-wal'), 'new native user message')
  const change = await read()
  assert.equal(change.type, 'change')
  assert.deepEqual(change.items.map(({ id }) => id), [input.id])
  const summary = await read()
  assert.equal(summary.type, 'thread-summary')
  assert.equal(summary.thread.preview, '第一条原生消息')
  assert.equal(summary.thread.status.type, 'active')
  await reader.cancel()
})

test('首个工作目录使用原生项目，重复选择同一路径复用它', async t => {
  const cwd = '/fixture/workspace'
  const project = { id: 'native-project', name: 'workspace', roots: [{ path: cwd }] }
  const projects = []
  const { get, messages } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: projects, nextCursor: null } }),
    'project/create': ({ name, roots, idempotencyKey }) => {
      assert.equal(name, project.name)
      assert.deepEqual(roots, project.roots)
      assert.ok(idempotencyKey)
      projects.push(project)
      return { result: { project } }
    },
  })
  const open = () => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'project', cwd }),
  })
  for (const response of await Promise.all([open(), open()])) assert.deepEqual((await response.json()).project, project)
  assert.deepEqual((await (await open()).json()).project, project)
  assert.equal(messages.filter(({ method }) => method === 'project/create').length, 1)
})

test('新建恢复同一工作区的未发送线程，待发或已写入历史的线程另开会话', async t => {
  const cwd = '/fixture/workspace'
  const draft = { id: 'original', cwd, projectId: 'project', name: null, preview: '', historyMode: 'paginated', status: { type: 'idle' } }
  let queued = false
  let materialized = false
  let starts = 0
  const { get } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: draft } }),
    'thread/queue/list': () => ({ result: { data: queued ? [{ id: 'queued' }] : [], nextCursor: null } }),
    'thread/turns/list': () => materialized ? { result: { data: [{ id: 'first' }] } }
      : { error: { code: -32600, message: 'thread original is not materialized yet; thread/turns/list is unavailable before first user message' } },
    'thread/start': () => ({ result: { thread: { ...draft, id: `new-${++starts}` } } }),
  })
  const open = async () => (await (await get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', cwd, projectId: draft.projectId, reuseThreadId: draft.id }),
  })).json()).thread
  assert.equal((await open()).id, draft.id)
  queued = true
  assert.equal((await open()).id, 'new-1')
  queued = false
  materialized = true
  assert.equal((await open()).id, 'new-2')
})

test('新回执在它对应的历史增量之后才进入会话阅读面', { timeout: 5000 }, async t => {
  const threadId = 'observed'
  const receipt = { revision: 'new', firstUnread: { type: 'turn', turnId: 'turn' } }
  let turn = { id: 'turn', status: 'inProgress', items: [] }
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: [turn] } }),
  })
  const response = await fixture.get(`/api/codex/watch?threadId=${threadId}`)
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.equal((await read()).type, 'snapshot')
  turn = { ...turn, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: '最新回复' }] }
  fixture.broadcast({ method: 'thread/readState/changed', params: { threadId, readState: receipt } })
  const change = await read()
  assert.equal(change.type, 'change')
  assert.equal(change.items[0].id, 'answer')
  assert.deepEqual(await read(), { type: 'reading-receipt', readState: receipt })
  await reader.cancel()
})

test('侧栏独立接收会话与项目增量，无需打开任何会话', { timeout: 5000 }, async t => {
  const project = { id: 'project', name: '新项目', roots: [] }
  const previousProject = { id: 'previous', name: '旧项目', roots: [] }
  const thread = { id: 'thread', name: '新名字', projectId: project.id }
  const fixture = await fakeCodex(t, {
    'config/read': () => ({ result: { config: {} } }),
    'thread/read': ({ threadId }) => ({ result: { thread: { ...thread, id: threadId } } }),
    'project/list': () => ({ result: { data: [project, previousProject], nextCursor: null } }),
  })
  const response = await fixture.get('/api/codex/watch?scope=catalog')
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.deepEqual(await read(), { type: 'catalog-ready' })
  const draft = { id: 'draft', historyMode: 'paginated', status: { type: 'idle' }, name: null, preview: '' }
  fixture.broadcast({ method: 'thread/started', params: { thread: draft } })
  assert.deepEqual(await read(), { type: 'thread', id: draft.id, thread: { ...draft, blank: true }, workspacePaths: {} })
  fixture.broadcast({ method: 'thread/started', params: { thread: { id: thread.id, name: '最初名字' } } })
  assert.deepEqual(await read(), { type: 'thread', id: thread.id, thread: { id: thread.id, name: '最初名字' }, workspacePaths: {} })
  fixture.broadcast({ method: 'thread/name/updated', params: { threadId: thread.id, threadName: thread.name } })
  fixture.broadcast({ method: 'project/changed', params: { projectId: project.id, changeType: 'updated' } })
  assert.deepEqual(await read(), { type: 'thread', id: thread.id, thread, workspacePaths: {} })
  assert.deepEqual(await read(), { type: 'projects', projects: [project, previousProject], workspacePaths: {} })
  fixture.broadcast({ method: 'thread/deleted', params: { threadId: thread.id } })
  assert.deepEqual(await read(), { type: 'thread', id: thread.id, thread: null })
  assert.equal(fixture.messages.some(message => ['thread/list', 'thread/turns/list', 'thread/resume'].includes(message.method)), false)
  await reader.cancel()
})

test('原生卸载只移除已读不到的空白草稿，保留仍可读取的历史', { timeout: 5000 }, async t => {
  const draft = { id: 'unloaded-draft', source: 'vscode', historyMode: 'paginated', status: { type: 'idle' }, preview: '' }
  const saved = { id: 'unloaded-saved', historyMode: 'paginated', status: { type: 'notLoaded' }, preview: '已写入的消息' }
  let draftLoaded = true
  const fixture = await fakeCodex(t, {
    'config/read': () => ({ result: { config: {} } }),
    'project/list': () => ({ result: { data: [] } }),
    'thread/list': () => ({ result: { data: [saved] } }),
    'thread/loaded/list': () => ({ result: { data: draftLoaded ? [draft.id] : [] } }),
    'thread/read': ({ threadId }) => {
      if (threadId === saved.id) return { result: { thread: saved } }
      if (draftLoaded) return { result: { thread: draft } }
      return { error: { code: -32600, message: `thread not loaded: ${threadId}` } }
    },
  })
  const response = await fixture.get('/api/codex/watch?scope=catalog')
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  try {
    assert.deepEqual(await read(), { type: 'catalog-ready' })
    const snapshot = await (await fixture.get('/api/codex/catalog?complete=1&fresh=1')).json()
    assert.deepEqual(snapshot.threads.find(thread => thread.id === draft.id), { ...draft, blank: true })

    draftLoaded = false
    const unloading = threadId => ({
      method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } },
    })
    fixture.broadcast(unloading(draft.id))
    fixture.broadcast({ method: 'thread/closed', params: { threadId: draft.id } })
    assert.deepEqual(await read(), { type: 'thread', id: draft.id, thread: null })

    const notification = unloading(saved.id)
    fixture.broadcast(notification)
    assert.deepEqual(await read(), { type: 'notification', notification, thread: saved, workspacePaths: {} })
    assert.equal(fixture.messages.some(({ method }) => method === 'thread/resume'), false)
  } finally {
    await reader.cancel()
  }
})

test('首轮结束后通过原生会话摘要更新侧栏预览', { timeout: 5000 }, async t => {
  const status = { type: 'idle' }
  const thread = { id: 'new', name: null, preview: '原生首条消息', status }
  const fixture = await fakeCodex(t, {
    'config/read': () => ({ result: { config: {} } }),
    'thread/read': ({ threadId }) => ({ result: { thread: { ...thread, id: threadId } } }),
  })
  const response = await fixture.get('/api/codex/watch?scope=catalog')
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  try {
    assert.deepEqual(await read(), { type: 'catalog-ready' })
    const notification = { method: 'thread/status/changed', params: { threadId: thread.id, status } }
    fixture.broadcast(notification)
    assert.deepEqual(await read(), { type: 'notification', notification, thread, workspacePaths: {} })
  } finally {
    await reader.cancel()
  }
})
