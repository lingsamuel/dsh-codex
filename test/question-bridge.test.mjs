import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { createQuestionBridge } from '../src/host/question-bridge.mjs'

const waiting = { type: 'active', activeFlags: ['waitingOnUserInput'] }
const threadId = 'native-thread'
const question = { id: 'plan', header: '方案', question: '采用哪种方案？', isOther: true, isSecret: false,
  options: [{ label: '保留', description: '沿用现有方式' }] }
const params = { threadId, turnId: 'turn', itemId: 'item', questions: [question], isBlocking: true }
const answer = { plan: { answers: ['保留'] } }
const requests = {
  command: { id: 'command', method: 'item/commandExecution/requestApproval', params: {
    threadId, turnId: 'turn', itemId: 'exec', command: 'pwd', cwd: '/work',
    availableDecisions: ['accept', 'acceptForSession', 'decline'],
  } },
  network: { id: 'network', method: 'item/commandExecution/requestApproval', params: {
    threadId, turnId: 'turn', itemId: 'network-check', command: 'check',
    networkApprovalContext: { host: 'example.invalid', protocol: 'https' }, availableDecisions: ['accept', 'cancel'],
  } },
  patch: { id: 'patch', method: 'item/fileChange/requestApproval', params: {
    threadId, turnId: 'turn', itemId: 'patch', grantRoot: '/work',
  } },
  permissions: { id: 'permissions', method: 'item/permissions/requestApproval', params: {
    threadId, turnId: 'turn', itemId: 'scope', cwd: '/work',
    permissions: { network: null, fileSystem: { read: ['/work/read'], write: null } },
  } },
}

const fileChanges = [{ path: '/work/note.txt', diff: '+hi', kind: { type: 'update', move_path: '/work/renamed.txt' } }]

async function nativeQuestions(t, { status = waiting, approvals = [], fileDetails = Promise.resolve(fileChanges) } = {}) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'question-rpc-'))
  const socketPath = join(directory, 'app.sock')
  const http = createServer()
  const sockets = new WebSocketServer({ server: http })
  const frames = []
  const send = (client, frame) => client.send(JSON.stringify(frame))
  const request = (client, id) => send(client, { id, method: 'item/tool/requestUserInput', params })
  const resolved = (client, requestId) => send(client, { method: 'serverRequest/resolved', params: { threadId, requestId } })
  const { promise: response, resolve: receivedResponse } = Promise.withResolvers()
  const answers = []
  sockets.on('connection', client => {
    client.on('message', async raw => {
      const frame = JSON.parse(raw.toString())
      frames.push(frame)
      if (!frame.method) {
        answers.push(frame)
        receivedResponse(frame)
        return
      }
      if (frame.id === undefined) return
      const result = frame.method === 'initialize' ? { codexHome: directory } : frame.method === 'thread/items/read'
        ? { data: [{ item: { id: 'patch', type: 'fileChange', changes: await fileDetails } }] }
        : { thread: { id: threadId, status } }
      send(client, { id: frame.id, result })
      if (frame.method === 'thread/resume') {
        for (const approval of approvals) send(client, approval)
        send(client, { id: 'empty', method: 'item/tool/requestUserInput', params: { ...params, questions: [] } })
        send(client, { id: 'secret', method: 'item/tool/requestUserInput',
          params: { ...params, questions: [question, { ...question, id: 'secret-input', isSecret: true }] } })
        request(client, 42)
      }
    })
  })
  http.listen(socketPath)
  await once(http, 'listening')
  t.after(async () => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    const closed = once(http, 'close')
    http.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  return { socketPath, sockets, frames, request, resolved, response, answers }
}

test('原生等待问答只在被查看时订阅，并保留 CLI 决定的解析顺序', { timeout: 5_000 }, async t => {
  const native = await nativeQuestions(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const bridge = createQuestionBridge(native.socketPath, controller.signal)
  const frames = []
  let nextFrame = Promise.withResolvers()
  const observer = bridge.observe(threadId, frame => {
    frames.push(frame)
    nextFrame.resolve(frame)
  }, controller.signal)
  const post = (requestId, answers = answer, id = threadId) => bridge.route.fetch(new Request('http://local/api/codex/question-answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: id, requestId, answers }),
  }))
  observer.update({ type: 'active', activeFlags: [] })
  assert.equal((await post('approval')).status, 409)
  assert.deepEqual(native.frames, [])
  observer.update(waiting)
  assert.deepEqual(await nextFrame.promise, { type: 'questions', requests: [{ requestId: 42, ...params }] })
  const [client] = native.sockets.clients
  assert.deepEqual(native.frames.find(frame => frame.method === 'thread/resume').params, { threadId, excludeTurns: true })
  assert.equal((await post('approval')).status, 409)
  assert.equal((await post('empty')).status, 409)
  assert.equal((await post('secret')).status, 409)
  assert.equal((await post(42, answer, 'different-thread')).status, 409)
  assert.equal((await post(42, { other: { answers: ['value'] } })).status, 400)
  assert.equal((await post(42)).status, 200)
  assert.deepEqual(await native.response, { id: 42, result: { answers: answer } })
  assert.equal((await post(42)).status, 409)
  assert.equal(frames.length, 1)
  nextFrame = Promise.withResolvers()
  native.resolved(client, 42)
  assert.deepEqual(await nextFrame.promise, { type: 'questions', requests: [] })
  nextFrame = Promise.withResolvers()
  native.request(client, 'native-string-id')
  assert.equal((await nextFrame.promise).requests[0].requestId, 'native-string-id')
  nextFrame = Promise.withResolvers()
  native.resolved(client, 'native-string-id')
  assert.deepEqual(await nextFrame.promise, { type: 'questions', requests: [] })
  assert.equal((await post('native-string-id')).status, 409)
  assert.deepEqual(native.frames.filter(frame => !frame.method), [{ id: 42, result: { answers: answer } }])
  nextFrame = Promise.withResolvers()
  native.request(client, 'before-archive')
  assert.equal((await nextFrame.promise).requests[0].requestId, 'before-archive')
  nextFrame = Promise.withResolvers()
  const closed = once(client, 'close')
  observer.update(null)
  assert.deepEqual(await nextFrame.promise, { type: 'questions', requests: [] })
  assert.equal((await post('before-archive')).status, 409)
  await closed
})


test('审批复用一次原生订阅，按请求可用的范围回复并随 CLI 决定清除', { timeout: 5_000 }, async t => {
  const status = { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] }
  const native = await nativeQuestions(t, { status, approvals: Object.values(requests) })
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const bridge = createQuestionBridge(native.socketPath, lifetime.signal)
  const decisions = bridge.approvalRoute
  assert.ok(decisions, '需要一个明确的审批回应路由')
  const { promise: all, resolve: initial } = Promise.withResolvers()
  const { promise: networkResolved, resolve: markNetworkResolved } = Promise.withResolvers()
  let latest = []
  const observer = bridge.observe(threadId, frame => {
    if (frame.type === 'approvals') {
      const hadNetwork = latest.some(entry => entry.requestId === 'network')
      latest = frame.requests
      if (hadNetwork && !latest.some(entry => entry.requestId === 'network')) markNetworkResolved()
    }
    if (frame.type === 'questions' && frame.requests.length && latest.length === 4) initial()
  }, lifetime.signal)
  const post = (requestId, decision, id = threadId, key = latest.find(entry => entry.requestId === requestId)?.key) =>
    decisions.fetch(new Request('http://local/api/codex/approval-decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      threadId: id, requestId, decision, key, permissions: { network: { enabled: true } },
    }),
  }))
  assert.equal((await post('command', 'accept')).status, 409)
  assert.deepEqual(native.frames, [])
  observer.update(status)
  await all
  const [client] = native.sockets.clients
  assert.equal(native.frames.filter(frame => frame.method === 'thread/resume').length, 1)
  assert.equal(latest.find(entry => entry.requestId === 'network').kind, 'network')
  assert.equal((await post('command', 'acceptForSession', 'different-thread')).status, 409)
  assert.equal((await post(42, 'accept')).status, 409)
  assert.equal((await post('command', 'accept', threadId, 'old-key')).status, 409)
  assert.equal((await post('network', 'acceptForSession')).status, 400)
  const results = await Promise.all([post('command', 'acceptForSession'), post('command', 'acceptForSession')])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  assert.deepEqual(await native.response, { id: 'command', result: { decision: 'acceptForSession' } })
  assert.equal((await post('permissions', 'accept')).status, 200)
  assert.equal((await post('patch', 'cancel')).status, 200)
  native.resolved(client, 'network')
  await networkResolved
  assert.equal((await post('network', 'accept')).status, 409)
  assert.deepEqual(native.answers, [
    { id: 'command', result: { decision: 'acceptForSession' } },
    { id: 'permissions', result: { permissions: { fileSystem: { read: ['/work/read'], write: null } }, scope: 'turn' } },
    { id: 'patch', result: { decision: 'cancel' } },
  ])
  assert.deepEqual(latest.find(entry => entry.requestId === 'patch').changes, fileChanges)
})

test('MCP 表单、外部授权与不支持的请求保留原生身份并随 CLI 答复关闭', { timeout: 5_000 }, async t => {
  const status = { type: 'active', activeFlags: ['waitingOnApproval'] }
  const elicitation = (id, mode, body) => ({ id, method: 'mcpServer/elicitation/request',
    params: { threadId, turnId: null, serverName: 'fixture', message: 'Enter values', mode, ...body },
  })
  const requestedSchema = {
    type: 'object', required: ['count', 'channel', 'labels', 'checked'], properties: {
      count: { type: 'integer', minimum: 1 }, channel: { type: 'string', oneOf: [{ const: 'web', title: 'Web' }] },
      labels: { type: 'array', items: { enum: ['one', 'two'], type: 'string' }, minItems: 1 },
      checked: { type: 'boolean', default: false }, email: { type: 'string', format: 'email' },
    },
  }
  const native = await nativeQuestions(t, { status, approvals: [elicitation(17, 'form', { requestedSchema }),
    elicitation('url', 'url', { url: 'https://example.invalid/request', elicitationId: 'server-form' }),
    elicitation('unsupported', 'form', { requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } }),
  ] })
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const bridge = createQuestionBridge(native.socketPath, lifetime.signal)
  assert.ok(bridge.mcpRoute, '需要明确的原生 MCP 回应路由')
  const { promise: ready, resolve: collected } = Promise.withResolvers()
  const { promise: resolved, resolve: removed } = Promise.withResolvers()
  let pending = []
  const observer = bridge.observe(threadId, frame => {
    if (frame.type !== 'mcp-requests') return
    if (pending.some(entry => entry.requestId === 'url') && !frame.requests.some(entry => entry.requestId === 'url')) removed()
    pending = frame.requests
    if (pending.length === 3) collected()
  }, lifetime.signal)
  observer.update(status)
  await ready
  const [client] = native.sockets.clients
  const post = (requestId, action, content, key = pending.find(entry => entry.requestId === requestId)?.key) =>
    bridge.mcpRoute.fetch(new Request('http://local/api/codex/mcp-elicitation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, requestId, action, content, key }),
    }))
  assert.equal(pending[1].url, 'https://example.invalid/request')
  assert.match(pending[2].error, /不支持/)
  const content = { count: 3, channel: 'web', labels: ['one'], checked: false }
  assert.equal((await post(17, 'accept', { ...content, count: '3' })).status, 400)
  assert.equal((await post(17, 'accept', { ...content, email: 'invalid' })).status, 400)
  assert.equal((await post(17, 'accept', { ...content, extra: 0 })).status, 400)
  assert.equal((await post(17, 'accept', content, 'stale')).status, 409)
  assert.equal((await post('url', 'accept', content)).status, 400)
  assert.equal((await post('unsupported', 'accept', {})).status, 400)
  assert.equal((await post(17, 'accept', content)).status, 200)
  assert.deepEqual(await native.response, { id: 17, result: { action: 'accept', content } })
  native.resolved(client, 'url')
  await resolved
  assert.equal((await post('url', 'accept')).status, 409)
  const { promise: urlReady, resolve: urlSent } = Promise.withResolvers()
  const urlWatcher = bridge.observe(threadId, frame => {
    if (frame.type === 'mcp-requests' && frame.requests.some(entry => entry.requestId === 'url-web')) urlSent()
  }, lifetime.signal)
  urlWatcher.update(status)
  client.send(JSON.stringify(elicitation('url-web', 'url', { url: 'https://example.invalid/next', elicitationId: 'form-next' })))
  await urlReady
  const urlReply = once(client, 'message')
  assert.equal((await post('url-web', 'accept')).status, 200)
  await urlReply
  const nativeReply = once(client, 'message')
  assert.equal((await post('unsupported', 'decline')).status, 200)
  await nativeReply
  assert.deepEqual(native.answers, [{ id: 17, result: { action: 'accept', content } },
    { id: 'url-web', result: { action: 'accept' } },
    { id: 'unsupported', result: { action: 'decline' } }])
})


test('文件审批等待完整的原生变更后才允许批准，等待期间仍能取消', { timeout: 5_000 }, async t => {
  const { promise: fileDetails, resolve: finishFileRead } = Promise.withResolvers()
  const status = { type: 'active', activeFlags: ['waitingOnApproval'] }
  const native = await nativeQuestions(t, { status, approvals: [requests.patch, { ...requests.patch, id: 'cancel-early' }], fileDetails })
  const lifetime = new AbortController()
  t.after(() => lifetime.abort())
  const bridge = createQuestionBridge(native.socketPath, lifetime.signal)
  const { promise: early, resolve: markEarly } = Promise.withResolvers()
  const { promise: ready, resolve: markReady } = Promise.withResolvers()
  let latest = []
  const observer = bridge.observe(threadId, frame => {
    if (frame.type !== 'approvals') return
    latest = frame.requests
    if (latest.length === 2) markEarly()
    if (latest.find(entry => entry.requestId === 'patch')?.changes) markReady()
  }, lifetime.signal)
  const decide = (id, decision) => bridge.approvalRoute.fetch(new Request('http://local/api/codex/approval-decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      threadId, requestId: id, decision, key: latest.find(entry => entry.requestId === id)?.key,
    }),
  }))
  observer.update(status)
  await early
  assert.deepEqual(latest[0].decisions, ['cancel'])
  assert.equal((await decide('patch', 'accept')).status, 400)
  assert.equal((await decide('patch', 'acceptForSession')).status, 400)
  assert.equal((await decide('cancel-early', 'cancel')).status, 200)
  assert.deepEqual(await native.response, { id: 'cancel-early', result: { decision: 'cancel' } })
  finishFileRead(fileChanges)
  await ready
  assert.deepEqual(latest[0].changes, fileChanges)
  assert.ok(latest[0].decisions.includes('acceptForSession'))
  assert.equal((await decide('patch', 'acceptForSession')).status, 200)
})
