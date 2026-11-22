import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { createHistoryRoutes } from '../src/host/history.mjs'

async function commandFixture(t, methods, settings = {}) {
  const runtime = join(process.cwd(), '.runtime')
  await mkdir(runtime, { recursive: true })
  const directory = await mkdtemp(join(runtime, 'cmd-'))
  const socketPath = join(directory, 'app.sock')
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const calls = []
  const owner = new AbortController()
  let thread
  let started = 0

  sockets.on('connection', socket => socket.on('message', message => {
    const { id, method, params } = JSON.parse(message)
    if (id === undefined) return
    calls.push({ method, params })
    let response
    if (method === 'initialize') response = { result: { userAgent: 'test Codex', codexHome: directory } }
    else if (method === 'thread/start') {
      thread = { id: ++started === 1 ? 'native-thread' : `native-thread-${started}`, cwd: params.cwd, status: { type: 'idle' }, model: params.model ?? 'default',
        modelProvider: params.modelProvider ?? 'openai', reasoningEffort: params.config?.model_reasoning_effort ?? 'low' }
      response = { result: { thread, model: thread.model, reasoningEffort: thread.reasoningEffort } }
    } else if (method === 'thread/read') response = { result: { thread } }
    else {
      response = methods[method]
        ? methods[method](params, socket, thread)
        : { error: { code: -32601, message: 'method not found' } }
    }
    if (response) socket.send(JSON.stringify({ id, ...response }))
  }))
  server.listen(socketPath)
  await once(server, 'listening')
  t.after(async () => {
    owner.abort()
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })

  const routes = createHistoryRoutes(socketPath, owner.signal, join(directory, 'cache'))
  const threadId = `web-new-${randomUUID()}`
  const request = (path, fields) => routes.find(route => route.path === path).fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, newSession: { cwd: directory }, clientUserMessageId: 'my-command-id', ...settings, ...fields }),
  }))
  return {
    calls, command: fields => request('/api/codex/command-action', fields),
    prompt: fields => request('/api/codex/conversation-action', { action: 'prompt', mode: 'queue', ...fields }),
  }
}

test('Goal 写入回执丢失后按目标正文与预算恢复，同一目标只创建一次', async t => {
  let goal = null
  const { calls, command } = await commandFixture(t, {
    'thread/goal/get': () => ({ result: { goal } }),
    'thread/goal/set': ({ objective, tokenBudget, status }, socket) => {
      goal = { objective, tokenBudget, status, createdAt: 123 }
      socket.terminate()
    },
  })
  const fields = { action: 'goal-create', objective: '完成核对', tokenBudget: 150 }
  assert.deepEqual(calls, [])
  assert.equal((await command({ ...fields, objective: ' ' })).status, 400)
  assert.deepEqual(calls, [])
  const first = await command(fields)
  assert.equal(first.status, 409)
  const failure = await first.json()
  assert.equal(failure.reason, 'new-session-delivery-unconfirmed')
  assert.equal(failure.newSessionRecovery.thread.id, 'native-thread')

  goal = { ...goal, tokenBudget: 200 }
  const wrongBudget = await command(fields)
  assert.equal(wrongBudget.status, 409)
  goal = { ...goal, tokenBudget: fields.tokenBudget }
  const recovered = await command(fields)
  assert.equal(recovered.status, 200)
  const result = await recovered.json()
  assert.equal(result.thread.id, 'native-thread')
  assert.deepEqual(result.goal, goal)
  const replay = await command(fields)
  assert.equal(replay.status, 200)
  assert.deepEqual((await replay.json()).goal, goal)
  assert.deepEqual(calls.filter(call => ['thread/start', 'thread/goal/set'].includes(call.method)).map(call => call.method),
    ['thread/start', 'thread/goal/set'])
})

test('审查被原生明确拒绝后可重试，回执未知后可以打开目标会话核对', async t => {
  let rejected = true
  const { calls, command } = await commandFixture(t, {
    'review/start': (_, socket) => {
      if (rejected) return { error: { code: -32602, message: '无法审查所选目标' } }
      socket.terminate()
    },
  })
  const fields = { action: 'review', target: { type: 'uncommittedChanges' } }
  const denied = await command(fields)
  assert.equal(denied.status, 400)

  rejected = false
  assert.equal((await command(fields)).status, 409)
  const unknown = await command(fields)
  assert.equal(unknown.status, 409)
  const failure = await unknown.json()
  assert.equal(failure.reason, 'new-session-delivery-unconfirmed')
  assert.equal(failure.newSessionRecovery.thread.id, 'native-thread')
  const reviews = calls.filter(call => call.method === 'review/start')
  assert.deepEqual(reviews.map(({ params }) => params), [
    { threadId: 'native-thread', target: fields.target }, { threadId: 'native-thread', target: fields.target },
  ])
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1)
})

test('审查首发应用所选模型提供商与协作模式', async t => {
  let appliedSettings
  const { calls, command } = await commandFixture(t, {
    'collaborationMode/list': () => ({ result: { data: [{ mode: 'default' }, { mode: 'plan' }] } }),
    'thread/settings/update': ({ model, effort, collaborationMode }, socket, thread) => {
      if (model) {
        thread.model = model
        thread.reasoningEffort = effort
      }
      if (collaborationMode) {
        thread.model = collaborationMode.settings.model
        thread.reasoningEffort = collaborationMode.settings.reasoning_effort
        thread.collaborationMode = collaborationMode
        socket.send(JSON.stringify({ method: 'thread/settings/updated', params: {
          threadId: thread.id, threadSettings: { collaborationMode },
        } }))
      }
      return { result: {} }
    },
    'review/start': (_, __, thread) => {
      appliedSettings = { model: thread.model, effort: thread.reasoningEffort, mode: thread.collaborationMode.mode }
      thread.status.type = 'active'
      return { result: { reviewThreadId: thread.id, turn: { id: 'review-turn' } } }
    },
  }, { modelDraft: { provider: 'custom', model: 'selected', reasoningEffort: 'high' }, planMode: 'plan' })
  const fields = { action: 'review', target: { type: 'uncommittedChanges' } }
  const response = await command(fields)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).turn.id, 'review-turn')
  assert.deepEqual(appliedSettings, { model: 'selected', effort: 'high', mode: 'plan' })
  const replay = await command(fields)
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).turn.id, 'review-turn')
  const differentTarget = await command({ ...fields, target: { type: 'baseBranch', branch: 'main' } })
  assert.equal(differentTarget.status, 409)
  assert.equal((await differentTarget.json()).reason, 'new-session-input-changed')
  assert.equal(calls.find(call => call.method === 'thread/start').params.modelProvider, 'custom')
  assert.equal(calls.filter(call => call.method === 'review/start').length, 1)
})

test('显式审查结束后，同一网页入口可独立发送首条消息', async t => {
  const { calls, command, prompt } = await commandFixture(t, {
    'review/start': ({ threadId }, _, thread) => {
      thread.status.type = 'active'
      return { result: { reviewThreadId: threadId, turn: { id: 'review-turn' } } }
    },
    'thread/queue/add': ({ clientUserMessageId }, _, thread) => {
      thread.status.type = 'active'
      return { result: { queuedSubmission: { id: 'queued-message', clientUserMessageId } } }
    },
  })
  const review = await command({ action: 'review', target: { type: 'uncommittedChanges' }, clientUserMessageId: 'review' })
  assert.equal(review.status, 200)
  const checked = await review.json()
  assert.equal(checked.thread.id, 'native-thread')

  const first = await prompt({ input: [{ type: 'text', text: '继续未发送的任务' }], clientUserMessageId: 'prompt' })
  assert.equal(first.status, 200)
  const sent = await first.json()
  assert.equal(sent.thread.id, 'native-thread-2')
  assert.equal(sent.queuedSubmission.clientUserMessageId, 'prompt')
  assert.deepEqual(calls.filter(({ method }) => method === 'review/start' || method === 'thread/queue/add')
    .map(({ method, params }) => [method, params.threadId]), [
    ['review/start', 'native-thread'], ['thread/queue/add', 'native-thread-2'],
  ])
})
