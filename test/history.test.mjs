import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { readCodex } from '../src/host/app-server.mjs'
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
    client.on('message', message => {
      const request = JSON.parse(message.toString())
      messages.push(request)
      if (request.id === undefined) return
      const reply = request.method === 'initialize'
        ? { result: { userAgent: 'test Codex' } }
        : methods[request.method]?.(request.params)
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
  const routes = createHistoryRoutes(socketPath)
  const get = path => routes.find(route => path.split('?')[0] === route.path)
    .fetch(new Request(`http://localhost${path}`))
  return { get, messages, clientClosed }
}

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
