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

async function nativeQuestions(t) {
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
  sockets.on('connection', client => {
    client.on('message', raw => {
      const frame = JSON.parse(raw.toString())
      frames.push(frame)
      if (!frame.method) {
        receivedResponse(frame)
        return
      }
      if (frame.id === undefined) return
      const result = frame.method === 'initialize' ? { codexHome: directory } : { thread: { id: threadId, status: waiting } }
      send(client, { id: frame.id, result })
      if (frame.method === 'thread/resume') {
        send(client, { id: 'approval', method: 'item/commandExecution/requestApproval', params })
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
  return { socketPath, sockets, frames, request, resolved, response }
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
  observer.update({ type: 'active', activeFlags: ['waitingOnApproval'] })
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
