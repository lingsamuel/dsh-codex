import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

const callerId = 'a0b1c2d3-e4f5-4789-a012-345678901234'
const targetId = 'b0b1c2d3-e4f5-4789-a012-345678901234'
const caller = { threadId: callerId, turnId: 'caller-turn' }
const idle = { type: 'idle' }
const active = { type: 'active', activeFlags: [] }
const waiting = { type: 'active', activeFlags: ['waitingOnApproval'] }
const thread = (id, fields = {}) => ({
  id, cwd: '/project', modelProvider: 'openai', projectId: 'project', historyMode: 'paginated',
  name: 'Title', preview: 'Preview', status: idle, createdAt: 1, updatedAt: 2, ...fields,
})
const agentMessage = (id, text) => ({ type: 'agentMessage', id, phase: 'final_answer', text })
const completed = (id, items = []) => ({ id, status: 'completed', items })
const unknownMethod = { code: -32601, message: 'Method not found' }

async function standalone(t, handler, { initializeDelay = 0 } = {}) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'task-mcp-'))
  const socketPath = join(directory, 'app.sock')
  const http = createServer()
  const ws = new WebSocketServer({ server: http })
  const calls = []
  ws.on('connection', client => {
    client.on('message', bytes => {
      const { id, method, params } = JSON.parse(bytes)
      if (method === 'initialize') {
        const reply = () => client.send(JSON.stringify({ id, result: { userAgent: 'test' } }))
        if (initializeDelay) {
          const timer = setTimeout(reply, initializeDelay)
          client.once('close', () => clearTimeout(timer))
        } else reply()
      } else if (method !== 'initialized') {
        calls.push([method, params])
        const reply = handler(method, params)
        if (reply !== false && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ id, ...(reply ?? { error: unknownMethod }) }))
        }
      }
    })
  })
  http.listen(socketPath)
  await once(http, 'listening')
  const child = spawn(process.execPath, ['src/host/codex-task-tools.mjs', socketPath])
  const childClosed = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  const pending = new Map()
  const output = createInterface({ input: child.stdout })
  output.on('line', line => {
    const frame = JSON.parse(line)
    pending.get(frame.id)?.resolve(frame)
    pending.delete(frame.id)
  })
  void childClosed.then(([exitCode, signal]) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`Task MCP exited (${exitCode ?? signal}): ${stderr}`))
    }
  })
  t.after(async () => {
    child.stdin.end()
    child.kill()
    await childClosed
    for (const client of ws.clients) client.terminate()
    ws.close()
    const closed = once(http, 'close')
    http.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  let id = 0
  const send = frame => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  function request(method, params) {
    const { promise, resolve, reject } = Promise.withResolvers()
    pending.set(++id, { resolve, reject })
    send({ id, method, params })
    return promise
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' }, capabilities: {},
  })
  assert.equal(initialized.result?.protocolVersion, '2025-11-25')
  send({ method: 'notifications/initialized' })
  const invoke = (name, args, meta = caller) => request('tools/call', { name, arguments: args, _meta: meta })
  return {
    calls, request, invoke,
    notifyAppServer(method, params) {
      for (const client of ws.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ method, params }))
      }
    },
    async call(...args) {
      const response = await invoke(...args)
      assert.ok(response.result, JSON.stringify(response.error))
      assert.equal(response.result.isError ?? false, false, JSON.stringify(response.result.content))
      return JSON.parse(response.result.content[0].text)
    },
    async fail(name, args, error, meta) {
      const response = await invoke(name, args, meta)
      assert.ok(response.error || response.result?.isError, JSON.stringify(response.result))
      assert.match(response.error?.message ?? response.result.content[0].text, error)
    },
  }
}

test('标准输入输出注册九项原生任务工具，列表保留原生顺序和归档游标', { timeout: 8_000 }, async t => {
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/list') return { result: { data: [thread(targetId), thread(callerId)], nextCursor: 'opaque' } }
  })
  const { result: { tools } } = await mcp.request('tools/list', {})
  assert.deepEqual(new Set(tools.map(tool => tool.name)), new Set([
    'list_threads', 'list_archived_threads', 'read_thread', 'wait_threads', 'send_message_to_thread',
    'create_thread', 'fork_thread', 'set_thread_title', 'set_thread_archived',
  ]))
  assert.deepEqual(tools.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name).sort(),
    ['list_archived_threads', 'list_threads', 'read_thread', 'wait_threads'])
  await mcp.fail('list_threads', { cursor: 'unexpected' }, /cursor/)
  await mcp.fail('list_threads', {}, /missing task metadata/, {})
  const current = await mcp.call('list_threads', {})
  assert.deepEqual(current.threads.map(entry => entry.id), [targetId, callerId])
  assert.deepEqual(current.pinnedThreads, [])
  const archive = await mcp.call('list_archived_threads', { cursor: 'previous', limit: 2 }, {
    'x-codex-turn-metadata': JSON.stringify({ thread_id: callerId, turn_id: 'caller-turn' }),
  })
  assert.equal(archive.nextCursor, 'opaque')
  assert.deepEqual(mcp.calls, [
    ['thread/list', { archived: false, limit: 10, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true }],
    ['thread/list', { archived: true, cursor: 'previous', limit: 2, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true }],
  ])
})

test('按原生游标读取历史，文本输出按需截断并排除不透明的条目字段', { timeout: 8_000 }, async t => {
  const mcpArguments = { query: 'docs', options: { limit: 2 } }
  const dynamicArguments = { paths: ['manual/guide.md'] }
  const items = [
    { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Question' }, { type: 'image', url: 'data:image/png;base64,INLINE_PAYLOAD' }] },
    { type: 'mcpToolCall', id: 'mcp', server: 'tools', tool: 'query', status: 'completed', arguments: mcpArguments, result: { concealed: 'RESULT_PAYLOAD' } },
    { type: 'dynamicToolCall', id: 'dynamic', tool: 'open', arguments: dynamicArguments, contentItems: [{ type: 'inputImage', imageUrl: 'DYNAMIC_PAYLOAD' }] },
    { type: 'commandExecution', id: 'command', command: 'status', status: 'completed', aggregatedOutput: '测试🙂output' },
    { type: 'imageGeneration', id: 'reference', fileId: 'saved-file' },
    { type: 'imageGeneration', id: 'generated', result: '图像🙂内容' },
    agentMessage('answer', 'Answer'),
  ]
  const mcp = await standalone(t, method => ({ result: method === 'thread/read'
    ? { thread: thread(targetId, { path: 'ROLLOUT_PAYLOAD', turns: [] }) }
    : { data: [completed('turn', items)], nextCursor: 'next-turn' } }))
  const summary = await mcp.call('read_thread', { threadId: targetId })
  const summaryItems = summary.turns[0].items
  assert.deepEqual(summaryItems.find(item => item.id === 'mcp').arguments, mcpArguments)
  assert.deepEqual(summaryItems.find(item => item.id === 'dynamic').arguments, dynamicArguments)
  assert.equal(summaryItems.find(item => item.id === 'command').output, undefined)
  assert.equal(summaryItems.find(item => item.id === 'generated').result, undefined)
  const detailed = await mcp.call('read_thread', { threadId: targetId, cursor: 'next-turn', includeOutputs: true, maxOutputCharsPerItem: 3 })
  assert.deepEqual(detailed.page, { order: 'newest_first', limit: 1, hasMore: true, nextCursor: 'next-turn' })
  assert.equal(detailed.turns[0].items.at(-1).text, 'Answer')
  assert.deepEqual(detailed.turns[0].items.find(item => item.id === 'command').output,
    { text: '测试🙂', truncated: true, originalChars: 9 })
  assert.equal(detailed.turns[0].items.find(item => item.id === 'reference').fileId, 'saved-file')
  assert.deepEqual(detailed.turns[0].items.find(item => item.id === 'generated').result,
    { text: '图像🙂', truncated: true, originalChars: 5 })
  assert.doesNotMatch(JSON.stringify(detailed), /(?:INLINE|DYNAMIC|RESULT|ROLLOUT)_PAYLOAD/)
  assert.deepEqual(mcp.calls.map(([method]) => method), ['thread/read', 'thread/turns/list', 'thread/read', 'thread/turns/list'])
  assert.equal(mcp.calls.at(-1)[1].cursor, 'next-turn')
})

test('旧版历史回退保持翻页，响应压缩保留助手回答和条目游标', { timeout: 8_000 }, async t => {
  const older = completed('older', [agentMessage('prior', 'Previous answer')])
  const newest = completed('newest', [
    { id: 'question', type: 'userMessage', content: [{ type: 'text', text: '问'.repeat(3000) }] },
    agentMessage('answer', '答'.repeat(3500)),
  ])
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') return { result: { thread: thread(targetId, { turns: params.includeTurns ? [older, newest] : [] }) } }
  })
  const result = await mcp.call('read_thread', { threadId: targetId })
  assert.equal(result.truncated, true)
  assert.equal(result.page.nextCursor, 'newest')
  assert.equal(result.turns[0].items.length, 1)
  assert.equal(result.turns[0].items[0].id, 'answer')
  assert.match(result.turns[0].items[0].text, /^答{100,}$/u)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8000)
  const previous = await mcp.call('read_thread', { threadId: targetId, cursor: result.page.nextCursor })
  assert.equal(previous.turns[0].items[0].text, 'Previous answer')
  assert.equal(previous.page.nextCursor, null)
})

test('超长工具参数触发原生响应压缩并保留助手回答和分页游标', { timeout: 8_000 }, async t => {
  const items = [
    { type: 'mcpToolCall', id: 'mcp', arguments: { query: '长'.repeat(8000) } },
    agentMessage('answer', 'Answer'),
  ]
  const mcp = await standalone(t, method => ({ result: method === 'thread/read'
    ? { thread: thread(targetId) } : { data: [completed('turn', items)], nextCursor: 'more' } }))
  const result = await mcp.call('read_thread', { threadId: targetId })
  assert.equal(result.truncated, true)
  assert.equal(result.page.nextCursor, 'more')
  assert.deepEqual(result.turns[0].items, [agentMessage('answer', 'Answer')])
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8000)
})

test('归档列表过长时保留所有项目及下一页游标', { timeout: 8_000 }, async t => {
  const entries = Array.from({ length: 50 }, (_, index) => thread(`a0b1c2d3-e4f5-4789-a012-${String(index).padStart(12, '0')}`, {
    name: '标题'.repeat(500), preview: '摘要'.repeat(100),
  }))
  const mcp = await standalone(t, () => ({ result: { data: entries, nextCursor: 'opaque-archive-cursor' } }))
  const result = await mcp.call('list_archived_threads', { limit: 50 })
  assert.equal(result.truncated, true)
  assert.deepEqual(result.threads.map(entry => entry.id), entries.map(entry => entry.id))
  assert.equal(result.nextCursor, 'opaque-archive-cursor')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8000)
})

test('即时等待返回任务快照，游标抑制重复结果并禁止等待自身或重复目标', { timeout: 8_000 }, async t => {
  let status = idle
  const answer = agentMessage('answer', 'Done')
  const marker = { type: 'commandExecution', id: 'command', status: 'completed' }
  const turn = completed('turn', [marker, answer])
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') return { result: { thread: thread(params.threadId, { status }) } }
    if (method === 'thread/turns/list') return { result: { data: [turn] } }
    if (method === 'thread/items/list') return { result: { data: [{ item: answer }, { item: marker }] } }
  })
  await mcp.fail('wait_threads', { targets: [{ threadId: callerId.toUpperCase() }], timeoutMs: 0 }, /calling task/)
  await mcp.fail('wait_threads', { targets: [{ threadId: targetId }, { threadId: targetId }], timeoutMs: 0 }, /duplicate/)
  const snapshot = await mcp.call('wait_threads', { targets: [{ threadId: targetId }], timeoutMs: 0 })
  assert.deepEqual(snapshot.wake, { threadId: targetId, reason: 'turnCompleted', turnId: 'turn' })
  assert.equal(snapshot.polls[0].latestAssistantMessage.text, 'Done')
  assert.equal(snapshot.polls[0].latestToolMarker.id, 'command')
  const targets = [{ threadId: targetId, afterCursor: snapshot.polls[0].cursor }]
  const unchanged = await mcp.call('wait_threads', { targets, timeoutMs: 0 })
  assert.equal(unchanged.wake, null)
  assert.equal(unchanged.timedOut, true)
  assert.equal(unchanged.polls[0].latestAssistantMessage, null)
  status = waiting
  const action = await mcp.call('wait_threads', { targets, timeoutMs: 0 })
  assert.deepEqual(action.wake, { threadId: targetId, reason: 'actionableStatus' })
  assert.ok(mcp.calls.every(([method]) => !/resume|start/.test(method)))
})

test('等待期间的原生状态通知能在下一次轮询前唤醒任务', { timeout: 8_000 }, async t => {
  let status = active
  const { promise: firstSnapshot, resolve } = Promise.withResolvers()
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') return { result: { thread: thread(params.threadId, { status }) } }
    if (method === 'thread/turns/list') return { result: { data: [{ id: 'turn', status: 'inProgress' }] } }
    if (method === 'thread/items/list') {
      resolve()
      return { result: { data: [] } }
    }
  })
  const result = mcp.call('wait_threads', { targets: [{ threadId: targetId }], timeoutMs: 750 })
  await firstSnapshot
  status = waiting
  mcp.notifyAppServer('thread/status/changed', { threadId: targetId, status })
  assert.deepEqual((await result).wake, { threadId: targetId, reason: 'actionableStatus' })
})

test('等待的正数预算包含 App Server 握手，零毫秒仍读取一次快照', { timeout: 8_000 }, async t => {
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') return { result: { thread: thread(params.threadId) } }
    if (method === 'thread/turns/list') return { result: { data: [] } }
  }, { initializeDelay: 250 })
  const targets = [{ threadId: targetId }]
  assert.deepEqual(await mcp.call('wait_threads', { targets, timeoutMs: 50 }), {
    timedOut: true, wake: null, polls: [], errors: [{ threadId: targetId, message: 'Timed out while reading task status' }],
  })
  assert.deepEqual(mcp.calls, [])
  const snapshot = await mcp.call('wait_threads', { targets, timeoutMs: 0 })
  assert.deepEqual(snapshot.wake, { threadId: targetId, reason: 'inactiveStatus' })
  assert.equal(snapshot.polls[0].thread.id, targetId)
})

test('分支按调用轮次或其他会话的进行中轮次排除未完成历史', { timeout: 8_000 }, async t => {
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') return { result: { thread: thread(params.threadId, { status: active }) } }
    if (method === 'thread/turns/list') return { result: { data: [{ id: 'target-turn', status: 'inProgress' }] } }
    if (method === 'thread/fork') return { result: { thread: thread('fork') } }
  })
  const source = await mcp.call('fork_thread', {}, { 'x-codex-turn-metadata': { thread_id: callerId, turn_id: 'caller-turn' } })
  const other = await mcp.call('fork_thread', { threadId: targetId })
  assert.equal(source.environment.type, 'same-directory')
  assert.equal(other.threadId, 'fork')
  const forks = mcp.calls.filter(([method]) => method === 'thread/fork').map(([, params]) => params)
  assert.deepEqual(forks.map(({ threadId, beforeTurnId, excludeTurns }) => ({ threadId, beforeTurnId, excludeTurns })), [
    { threadId: callerId, beforeTurnId: 'caller-turn', excludeTurns: true },
    { threadId: targetId, beforeTurnId: 'target-turn', excludeTurns: true },
  ])
  for (const { config } of forks) assert.equal(config['mcp_servers.dsh_codex_tasks'].tools.fork_thread.approval_mode, 'prompt')
  assert.ok(mcp.calls.every(([method]) => method !== 'turn/start'))
})

test('新建任务继承有效设置，跨会话输入使用工具输出权限及原生转义', { timeout: 8_000 }, async t => {
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') return { result: { thread: thread(params.threadId,
      { status: params.threadId === targetId ? { type: 'notLoaded' } : idle }) } }
    if (method === 'thread/resume') return { result: {
      thread: thread(params.threadId), model: 'parent-model', runtimeWorkspaceRoots: ['/project', '/other'],
      serviceTier: null, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      activePermissionProfile: { id: 'workspace-profile' }, sandbox: { type: 'workspaceWrite' },
    } }
    if (method === 'thread/start') return { result: { thread: thread('new-task') } }
    if (method === 'thread/name/set') return { result: {} }
    if (method === 'turn/start') return { result: { turn: completed('turn') } }
  })
  await mcp.fail('create_thread', { prompt: '问'.repeat(334) }, /maximum context budget/)
  assert.deepEqual(await mcp.call('create_thread', { prompt: 'Check <case> & report', title: ' Child ' }), { threadId: 'new-task' })
  assert.deepEqual(await mcp.call('send_message_to_thread', { threadId: targetId, prompt: 'Follow up', model: 'new-model' }), { threadId: targetId })
  const [, start] = mcp.calls.find(([method]) => method === 'thread/start')
  assert.deepEqual({ ...start, config: true }, {
    cwd: '/project', projectId: 'project', modelProvider: 'openai', historyMode: 'paginated', ephemeral: false,
    model: 'parent-model', serviceTier: null, runtimeWorkspaceRoots: ['/project', '/other'],
    approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: 'workspace-profile', config: true,
  })
  assert.deepEqual(mcp.calls.find(([method]) => method === 'thread/name/set')[1], { threadId: 'new-task', name: 'Child' })
  const turns = mcp.calls.filter(([method]) => method === 'turn/start').map(([, params]) => params)
  assert.deepEqual(turns[0].input, [])
  assert.equal(turns[0].toolOutput.name, 'create_thread')
  assert.equal(turns[0].toolOutput.output,
    `<codex_delegation>\n  <source_thread_id>${callerId}</source_thread_id>\n  <input>Check &lt;case&gt; &amp; report</input>\n</codex_delegation>`)
  assert.equal(turns[1].model, 'new-model')
  assert.equal(turns[1].toolOutput.name, 'send_message_to_thread')
  assert.equal(mcp.calls.filter(([method]) => method === 'thread/resume').at(-1)[1].config['mcp_servers.dsh_codex_tasks'].tools.send_message_to_thread.approval_mode, 'prompt')
})

test('跨会话输入跳过已加载空会话的恢复，包括检查期间由其他客户端恢复的目标', { timeout: 8_000 }, async t => {
  let firstRead = true
  const racedId = 'c0b1c2d3-e4f5-4789-a012-345678901234'
  const mcp = await standalone(t, (method, params) => {
    if (method === 'thread/read') {
      const notLoaded = params.threadId === racedId && firstRead
      if (notLoaded) firstRead = false
      return { result: { thread: thread(params.threadId, { status: notLoaded ? { type: 'notLoaded' } : idle }) } }
    }
    if (method === 'thread/resume') return { error: { code: -32600, message: 'thread has no rollout' } }
    if (method === 'turn/start') return { result: { turn: completed('turn') } }
  })
  for (const threadId of [targetId, racedId]) {
    assert.deepEqual(await mcp.call('send_message_to_thread', { threadId, prompt: 'Follow up' }), { threadId })
  }
  assert.deepEqual(mcp.calls.filter(([method]) => method === 'thread/resume'), [])
})

test('改名默认使用调用者，归档禁止调用者自身，恢复仅提交目标', { timeout: 8_000 }, async t => {
  const mcp = await standalone(t, () => ({ result: {} }))
  await mcp.fail('set_thread_archived', { archived: true, threadId: callerId.toUpperCase() }, /calling task/)
  assert.deepEqual(await mcp.call('set_thread_title', { title: 'Name' }), { threadId: callerId, title: 'Name' })
  assert.deepEqual(await mcp.call('set_thread_archived', { archived: true, threadId: targetId }), { threadId: targetId, archived: true })
  assert.deepEqual(await mcp.call('set_thread_archived', { archived: false, threadId: targetId }), { threadId: targetId, archived: false })
  assert.deepEqual(mcp.calls, [
    ['thread/name/set', { threadId: callerId, name: 'Name' }], ['thread/archive', { threadId: targetId }],
    ['thread/unarchive', { threadId: targetId }],
  ])
})
