import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
        ? { result: { userAgent: 'test Codex', codexHome: directory } }
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
  return {
    get, messages, clientClosed, socketPath, directory,
    broadcast(message) {
      for (const client of ws.clients) client.send(JSON.stringify(message))
    },
  }
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

test('侧栏独立接收会话与项目增量，无需打开任何会话', { timeout: 5000 }, async t => {
  const project = { id: 'project', name: '新项目', roots: [] }
  const thread = { id: 'thread', name: '新名字', projectId: project.id }
  const fixture = await fakeCodex(t, {
    'config/read': () => ({ result: { config: {} } }),
    'thread/read': ({ threadId }) => ({ result: { thread: { ...thread, id: threadId } } }),
    'project/read': ({ projectId }) => ({ result: { project: { ...project, id: projectId } } }),
  })
  const response = await fixture.get('/api/codex/watch?scope=catalog')
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.deepEqual(await read(), { type: 'catalog-ready' })
  fixture.broadcast({ method: 'thread/started', params: { thread: { id: thread.id, name: '最初名字' } } })
  assert.deepEqual(await read(), { type: 'thread', id: thread.id, thread: { id: thread.id, name: '最初名字' }, workspacePaths: {} })
  fixture.broadcast({ method: 'thread/name/updated', params: { threadId: thread.id, threadName: thread.name } })
  fixture.broadcast({ method: 'project/changed', params: { projectId: project.id, changeType: 'updated' } })
  assert.deepEqual(await read(), { type: 'thread', id: thread.id, thread, workspacePaths: {} })
  assert.deepEqual(await read(), { type: 'project', id: project.id, project, workspacePaths: {} })
  fixture.broadcast({ method: 'thread/deleted', params: { threadId: thread.id } })
  assert.deepEqual(await read(), { type: 'thread', id: thread.id, thread: null })
  assert.equal(fixture.messages.some(message => ['thread/list', 'thread/turns/list', 'thread/resume'].includes(message.method)), false)
  await reader.cancel()
})
