import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { createAsyncQuestionActionRoute } from '../src/host/async-question-actions.mjs'
import { questionReplies } from '../src/shared/question-replies.js'

const threadId = 'thread'
const turnId = 'turn'
const itemId = 'ask-item'
const item = { type: 'agentMessage', id: itemId, text: '', questions: [
  { title: '部署位置？', options: ['测试', '生产'] },
  { title: '执行时间？', options: null },
  { title: '备注？', options: null },
] }
const reply = (index, answer) => ({ questionItemId: `["request_user_input_async","ask-item",${index}]`, question: item.questions[index].title, answer })
const input = payload => [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify(payload)}\n</send_user_message_question_reply>`, text_elements: [] }]

async function fakeCodex(t, methods) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'async-rpc-'))
  const socketPath = join(directory, 'app.sock')
  const http = createServer()
  const sockets = new WebSocketServer({ server: http })
  const frames = []
  sockets.on('connection', client => {
    client.on('message', async raw => {
      const frame = JSON.parse(raw.toString())
      if (frame.id === undefined) return
      const { id, method, params } = frame
      frames.push(frame)
      const result = method === 'initialize' ? { codexHome: directory } : await methods[method]?.(params)
      const error = result?.error ?? (!result && { code: -32601, message: method })
      client.send(JSON.stringify(error ? { id, error } : { id, result }))
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
  const route = createAsyncQuestionActionRoute(socketPath)
  const post = (answers, fields) => route.fetch(new Request('http://local/api/codex/async-question-answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId, turnId, itemId, answers, ...fields }),
  }))
  return { post, frames }
}

test('异步提问保留 CLI 已回答项，向运行轮次插话，冷会话则恢复并发送', { timeout: 5_000 }, async t => {
  let status = { type: 'active', activeFlags: [] }
  let head = turnId
  let headStatus = 'inProgress'
  const accepted = []
  const queued = [{ id: 'cli-queued', input: input([reply(1, '晚上')]) }]
  const saved = [{ turnId, item: { type: 'userMessage', id: 'cli-answer', content: input(reply(0, '测试')) } }]
  const { post, frames } = await fakeCodex(t, {
    'thread/read': () => ({ thread: { id: threadId, status } }),
    'thread/items/read': ({ turnId: id, itemIds }) => ({ data: id === turnId && itemIds[0] === itemId ? [{ turnId, item }] : [] }),
    'thread/items/list': ({ cursor }) => cursor === 'second' ? { data: saved } : { data: [], nextCursor: 'second' },
    'thread/turns/list': () => ({ data: [{ id: head, status: headStatus }] }),
    'thread/queue/list': () => ({ data: queued }),
    'turn/steer': params => {
      accepted.push(params)
      saved.push({ turnId, item: { type: 'userMessage', id: 'web-answer', content: params.input } })
      return { turnId }
    },
    'thread/queue/add': params => {
      accepted.push(params)
      const queuedSubmission = { id: 'native-queued', ...params }
      queued.push(queuedSubmission)
      return { queuedSubmission }
    },
    'thread/resume': () => {
      status = { type: 'idle' }
      return { thread: { id: threadId, status } }
    },
  })
  const batch = [{ index: 0, answer: '生产' }, { index: 1, answer: '中午' }, { index: 2, answer: '  先备份\n保留日志  ' }]
  const result = await post(batch)
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()))
  assert.deepEqual(await result.json(), { submitted: true })
  assert.deepEqual(questionReplies(accepted[0].input), [reply(2, '先备份\n保留日志')])
  assert.equal(accepted[0].expectedTurnId, turnId)
  assert.equal(frames.some(frame => frame.method === 'thread/resume' || frame.method === 'thread/queue/add'), false)
  assert.deepEqual(frames.find(frame => frame.method === 'thread/items/list').params.cursor, { type: 'item', itemId })
  assert.deepEqual(await (await post(batch)).json(), { submitted: false })
  assert.equal(accepted.length, 1)
  assert.equal((await post([{ index: 3, answer: '越界' }])).status, 400)
  assert.equal((await post(batch, { itemId: 'missing' })).status, 409)

  queued.length = 0
  saved.length = 0
  head = 'newer-turn'
  assert.equal((await post(batch)).status, 409)
  status = { type: 'notLoaded' }
  head = turnId
  headStatus = 'completed'
  assert.deepEqual(await (await post([{ index: 2, answer: '先备份\n保留日志' }])).json(), { submitted: true })
  assert.deepEqual(frames.find(frame => frame.method === 'thread/resume').params, { threadId, excludeTurns: true })
  assert.equal(accepted[1].clientUserMessageId, accepted[0].clientUserMessageId)
})

test('原生拒绝插话后仅在提问轮次仍是最后一轮时排队', async t => {
  for (const { message, nextId, expectedStatus, queued } of [
    { message: 'no active turn to steer', nextId: turnId, expectedStatus: 200, queued: true },
    { message: 'cannot steer a review turn', nextId: turnId, expectedStatus: 200, queued: true },
    { message: 'expected active turn id `turn` but found `new`', nextId: 'new', expectedStatus: 409, queued: false },
    { message: 'native request failed', nextId: turnId, expectedStatus: 400, queued: false },
  ]) {
    await t.test(message, async t => {
      let head = { id: turnId, status: 'inProgress' }
      const { post, frames } = await fakeCodex(t, {
        'thread/read': () => ({ thread: { id: threadId, status: { type: 'active' }, historyMode: 'paginated' } }),
        'thread/queue/list': () => ({ data: [] }),
        'thread/items/read': () => ({ data: [{ turnId, item }] }),
        'thread/items/list': () => ({ data: [] }),
        'thread/turns/list': () => ({ data: [head] }),
        'turn/steer': () => {
          head = { id: nextId, status: 'completed' }
          return { error: { code: -32600, message } }
        },
        'thread/queue/add': () => ({ queuedSubmission: { id: 'queued' } }),
      })
      const response = await post([{ index: 0, answer: '测试' }])
      assert.equal(response.status, expectedStatus)
      const steer = frames.find(frame => frame.method === 'turn/steer')
      assert.equal(steer?.params.expectedTurnId, turnId)
      const add = frames.find(frame => frame.method === 'thread/queue/add')
      assert.equal(Boolean(add), queued)
      if (add) assert.equal(add.params.clientUserMessageId, steer.params.clientUserMessageId)
    })
  }
})

test('旧式原生历史按末轮完整记录验证，并发网页答复只送到队列一次', { timeout: 5_000 }, async t => {
  const { promise: adding, resolve: addStarted } = Promise.withResolvers()
  const { promise: release, resolve: addFinished } = Promise.withResolvers()
  const { post, frames } = await fakeCodex(t, {
    'thread/read': () => ({ thread: { id: threadId, status: { type: 'active' }, historyMode: 'legacy' } }),
    'thread/queue/list': () => ({ data: [] }),
    'thread/turns/list': ({ itemsView }) => ({ data: [{ id: turnId, items: itemsView === 'full' ? [item,
      { type: 'userMessage', id: 'cli-answer', content: input(reply(0, '测试')) }] : [] }] }),
    'thread/queue/add': async params => {
      addStarted()
      await release
      return { queuedSubmission: { id: 'queued', ...params } }
    },
  })
  const batch = [{ index: 0, answer: '生产' }, { index: 1, answer: '明天' }]
  const first = post(batch)
  const started = await Promise.race([adding.then(() => true), first.then(() => false)])
  assert.equal(started, true, '旧式历史中的异步题应允许原生队列收件')
  assert.equal((await post(batch)).status, 409)
  addFinished()
  assert.deepEqual(await (await first).json(), { submitted: true })
  const adds = frames.filter(frame => frame.method === 'thread/queue/add')
  assert.equal(adds.length, 1)
  assert.deepEqual(questionReplies(adds[0].params.input), [reply(1, '明天')])
})

test('冷会话加载失败时标明失败阶段且不尝试入队', async t => {
  const { post, frames } = await fakeCodex(t, {
    'thread/read': () => ({ thread: { id: threadId, status: { type: 'notLoaded' }, historyMode: 'paginated' } }),
    'thread/queue/list': () => ({ data: [] }),
    'thread/items/read': () => ({ data: [{ turnId, item }] }),
    'thread/items/list': () => ({ data: [] }),
    'thread/turns/list': () => ({ data: [{ id: turnId }] }),
  })
  const response = await post([{ index: 0, answer: '测试' }])
  assert.match((await response.json()).error, /加载会话失败.*thread\/resume/)
  assert.equal(frames.some(frame => frame.method === 'thread/queue/add'), false)
})

test('冷恢复已有消息进入新轮次时拒绝旧问题的异步答复', async t => {
  let head = turnId
  const { post, frames } = await fakeCodex(t, {
    'thread/read': () => ({ thread: { id: threadId, status: { type: 'notLoaded' }, historyMode: 'paginated' } }),
    'thread/queue/list': () => ({ data: [] }),
    'thread/items/read': () => ({ data: [{ turnId, item }] }),
    'thread/items/list': () => ({ data: [] }),
    'thread/turns/list': () => ({ data: [{ id: head }] }),
    'thread/resume': () => {
      head = 'new-turn'
      return { thread: { id: threadId, status: { type: 'active' } } }
    },
    'thread/queue/add': () => ({ queuedSubmission: { id: 'unexpected' } }),
  })
  assert.equal((await post([{ index: 0, answer: '测试' }])).status, 409)
  assert.equal(frames.some(frame => frame.method === 'thread/queue/add'), false)
})
