import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
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
  const get = (path, options) => routes.find(route => path.split('?')[0] === route.path)
    .fetch(new Request(`http://localhost${path}`, options))
  return {
    get, messages, clientClosed, socketPath, directory,
    broadcast(message) {
      for (const client of ws.clients) client.send(JSON.stringify(message))
    },
  }
}

test('网页会话创建和显式加载沿用原生配置，普通发送只进入队列', async t => {
  const thread = { id: 'native-thread', cwd: '/mock', status: { type: 'notLoaded' } }
  const input = [{ type: 'text', text: '请继续', text_elements: [] }]
  const queuedSubmission = { id: 'queued-id', clientUserMessageId: 'browser-id', input }
  const { socketPath, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/start': () => ({ result: { thread } }),
    'thread/resume': () => {
      thread.status = { type: 'idle' }
      return { result: { thread } }
    },
    'thread/queue/add': () => ({ result: { queuedSubmission } }),
    'turn/steer': ({ expectedTurnId }) => expectedTurnId === 'active-turn' ? { result: { turnId: 'active-turn' } }
      : { error: { code: -32600, message: 'expected active turn id `stale-turn` but found `active-turn`' } },
    'turn/interrupt': () => ({ result: {} }),
  })
  const route = createConversationActionRoute(socketPath)
  const post = (action, fields) => route.fetch(new Request('http://local/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }),
  }))

  assert.equal((await post('thread/start', { cwd: thread.cwd })).status, 400)
  assert.deepEqual((await (await post('create', { cwd: thread.cwd, projectId: 'project-id', approvalPolicy: 'never' })).json()).thread, thread)
  assert.equal((await post('prompt', { threadId: thread.id, mode: 'queue', input, clientUserMessageId: 'browser-id' })).status, 409)
  assert.equal((await post('resume', { threadId: thread.id, path: '/another-rollout' })).status, 200)
  assert.equal((await post('resume', { threadId: thread.id })).status, 200)
  assert.deepEqual(await (await post('prompt', { threadId: thread.id, mode: 'queue', input, clientUserMessageId: 'browser-id' })).json(), { queuedSubmission })
  assert.deepEqual(await (await post('prompt', { threadId: thread.id, mode: 'steer', input, clientUserMessageId: 'browser-id' })).json(), { queuedSubmission })
  assert.deepEqual(await (await post('prompt', { threadId: thread.id, mode: 'steer', input, clientUserMessageId: 'browser-id', expectedTurnId: 'stale-turn' })).json(), { queuedSubmission })
  assert.equal((await post('prompt', { threadId: thread.id, mode: 'steer', input, clientUserMessageId: 'browser-id', expectedTurnId: 'active-turn' })).status, 200)
  assert.equal((await post('cancel', { threadId: thread.id, turnId: 'active-turn' })).status, 200)
  assert.deepEqual(messages.filter(({ method }) => /^(thread|turn)\//.test(method) && method !== 'thread/read')
    .map(({ method, params }) => [method, params]), [
    ['thread/start', { cwd: thread.cwd, historyMode: 'paginated', projectId: 'project-id' }],
    ['thread/resume', { threadId: thread.id, excludeTurns: true }],
    ['thread/queue/add', { threadId: thread.id, input, clientUserMessageId: 'browser-id' }],
    ['thread/queue/add', { threadId: thread.id, input, clientUserMessageId: 'browser-id' }],
    ['turn/steer', { threadId: thread.id, input, clientUserMessageId: 'browser-id', expectedTurnId: 'stale-turn' }],
    ['thread/queue/add', { threadId: thread.id, input, clientUserMessageId: 'browser-id' }],
    ['turn/steer', { threadId: thread.id, input, clientUserMessageId: 'browser-id', expectedTurnId: 'active-turn' }],
    ['turn/interrupt', { threadId: thread.id, turnId: 'active-turn' }],
  ])
})

test('队列编辑保留原生附件，显式插话拒绝后保留待发文本', async t => {
  const threadId = 'native-thread'
  const attachment = { type: 'localImage', path: '/mock/image.png' }
  const text = value => ({ type: 'text', text: value, text_elements: [] })
  const item = { id: 'queued-id', clientUserMessageId: 'browser-id', input: [text('before'), attachment] }
  const { socketPath, messages } = await fakeCodex(t, {
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
  assert.equal((await refused.json()).reason, 'steer-unavailable')
  assert.deepEqual(messages.filter(({ method }) => ['thread/queue/add', 'turn/steer'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['turn/steer', { threadId, input: item.input, clientUserMessageId: item.clientUserMessageId, expectedTurnId: 'completed-turn' }],
    ['thread/queue/add', { threadId, input: item.input, clientUserMessageId: item.clientUserMessageId }],
  ])
  assert.deepEqual(await (await queue('start')).json(), { turn: { id: 'resumed-turn' } })
  assert.deepEqual(messages.at(-1).params, { threadId })
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
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/revert': () => ({ result: { thread } }),
  })
  const post = beforeTurnId => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: thread.id, action: 'revert', beforeTurnId }),
  })
  assert.equal((await post(undefined)).status, 400)
  const running = await post('earlier')
  assert.equal(running.status, 409)
  assert.match((await running.json()).error, /停止当前轮次/)
  thread.status.type = 'notLoaded'
  const cold = await post('earlier')
  assert.equal(cold.status, 409)
  assert.match((await cold.json()).error, /尚未加载/)
  thread.status.type = 'idle'
  assert.equal((await post('earlier')).status, 200)
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/revert').map(({ params }) => params), [
    { threadId: thread.id, beforeTurnId: 'earlier' },
  ])
  assert.equal(messages.some(({ method }) => method === 'thread/resume'), false)
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
