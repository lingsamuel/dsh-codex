import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { readCodex } from '../src/host/app-server.mjs'
import { createConversationActionRoute } from '../src/host/conversation-actions.mjs'
import { createHistoryRoutes } from '../src/host/history.mjs'
import { createWatchRoute } from '../src/host/live-watch.mjs'
import { asyncQuestionItemId, encodeQuestionReplies } from '../src/shared/question-replies.js'
import { fileAttachmentInput } from '../src/shared/file-attachments.js'
import { createLocalAttachmentStore } from './support/dsh-attachments.mjs'
import { codexTaskToolsConfig, codexTaskToolsServerName } from '../src/host/codex-task-tools-config.mjs'
import { encodeThreadReference } from '../src/shared/thread-references.js'

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
  const openRoutes = cacheDirectory => {
    const routes = createHistoryRoutes(socketPath, owner.signal, cacheDirectory)
    return (path, options) => routes.find(route => path.split('?')[0] === route.path)
      ?.fetch(new Request(`http://localhost${path}`, options)) ?? Response.json({}, { status: 404 })
  }
  return {
    get: openRoutes(), openRoutes, messages, clientClosed, socketPath, directory,
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

function postCodex(get, path, fields) {
  return get(`/api/codex/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  })
}

function openHistoryProjection(directory) {
  const db = new DatabaseSync(join(directory, 'thread_history_1.sqlite'))
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY,
      next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);`)
  return db
}

test('新会话只在首发时创建，回执丢失可按原生队列确认', async t => {
  let thread
  let queued
  let firstConnection
  const fixture = await fakeCodex(t, {
    'thread/start': ({ cwd }, client) => {
      firstConnection = client
      thread = { id: 'native-draft', cwd, historyMode: 'paginated', status: { type: 'idle' } }
      return { result: { thread } }
    },
    'thread/read': () => ({ result: { thread } }),
    'thread/queue/add': ({ input, clientUserMessageId }, client) => {
      queued = { id: 'queued', input, clientUserMessageId }
      client.terminate()
    },
    'thread/queue/list': () => ({ result: { data: queued ? [queued] : [] } }),
    'thread/queue/start': () => ({ result: { turn: { id: 'first-turn' } } }),
  })
  const get = fixture.openRoutes(join(fixture.directory, 'profile'))
  const threadId = 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd'
  const attempt = { action: 'prompt', threadId, newSession: { cwd: fixture.directory }, mode: 'queue',
    clientUserMessageId: 'send-once', input: [{ type: 'text', text: '这条消息只发送一次' }] }
  assert.equal((await get('/api/codex/drafts')).status, 404)
  assert.equal((await postCodex(get, 'conversation-action', { action: 'create', cwd: fixture.directory })).status, 400)
  assert.equal((await postCodex(get, 'conversation-action', { ...attempt, input: [] })).status, 400)
  assert.equal(fixture.messages.length, 0)

  const lost = await postCodex(get, 'conversation-action', attempt)
  assert.equal(lost.status, 409)
  const failure = await lost.json()
  assert.equal(failure.reason, 'new-session-delivery-unconfirmed')
  assert.equal(failure.newSessionRecovery.thread.id, thread.id)
  if (firstConnection.readyState < 2) await once(firstConnection, 'close', { signal: AbortSignal.timeout(1_000) })

  const changed = await postCodex(get, 'conversation-action', { ...attempt, input: [{ type: 'text', text: '已修改' }] })
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).reason, 'new-session-input-changed')
  const [recovered, replayed] = await Promise.all([
    postCodex(get, 'conversation-action', attempt),
    postCodex(get, 'conversation-action', attempt),
  ])
  for (const response of [recovered, replayed]) {
    assert.equal(response.status, 200)
    const receipt = await response.json()
    assert.equal(receipt.thread.id, thread.id)
    assert.deepEqual(receipt.workspacePaths, {})
    assert.equal(receipt.queuedSubmission.id, queued.id)
    assert.equal(receipt.clientUserMessageId, attempt.clientUserMessageId)
  }
  assert.deepEqual(fixture.messages.filter(item => ['thread/start', 'thread/queue/add'].includes(item.method))
    .map(item => item.method), ['thread/start', 'thread/queue/add'])
})

test('明确拒绝入队后，向变更的目录和项目重新启动原生线程', async t => {
  let rejected = true
  const threads = new Map()
  const fixture = await fakeCodex(t, {
    'thread/start': ({ cwd, projectId }) => {
      const thread = { id: `native-${threads.size}`, cwd, projectId, status: { type: 'active' } }
      threads.set(thread.id, thread)
      return { result: { thread } }
    },
    'thread/read': ({ threadId }) => ({ result: { thread: threads.get(threadId) } }),
    'thread/queue/add': ({ clientUserMessageId }) => rejected
      ? { error: { code: -32602, message: '尚未入队' } }
      : { result: { queuedSubmission: { id: 'queued-new', clientUserMessageId } } },
  })
  const get = fixture.openRoutes(join(fixture.directory, 'profile'))
  const cwd = join(fixture.directory, 'new-project')
  await mkdir(cwd)
  const attempt = { action: 'prompt', threadId: 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd',
    newSession: { cwd: fixture.directory, projectId: 'first-project' }, mode: 'queue',
    clientUserMessageId: 'original-attempt', input: [{ type: 'text', text: '待发' }] }
  assert.equal((await postCodex(get, 'conversation-action', attempt)).status, 400)
  rejected = false
  const retried = await postCodex(get, 'conversation-action', { ...attempt, newSession: { cwd, projectId: 'second-project' } })
  assert.equal(retried.status, 200)
  const { thread } = await retried.json()
  assert.deepEqual([thread.id, thread.cwd, thread.projectId], ['native-1', cwd, 'second-project'])
  const writes = fixture.messages.filter(({ method }) => method === 'thread/queue/add')
  assert.deepEqual(writes.map(({ params }) => params.threadId), ['native-0', 'native-1'])
})

test('首条消息明确被拒后，原生空线程卸载仍可重试', async t => {
  let thread
  let starts = 0
  let rejected = true
  const { get, directory, messages } = await fakeCodex(t, {
    'thread/start': ({ cwd }) => {
      thread = { id: `native-${++starts}`, cwd, status: { type: 'active' } }
      return { result: { thread } }
    },
    'thread/read': ({ threadId }) => thread?.id === threadId ? { result: { thread } }
      : { error: { code: -32600, message: `thread not found: ${threadId}` } },
    'thread/queue/add': ({ clientUserMessageId }) => rejected ? { error: { code: -32602, message: '暂未入队' } }
      : { result: { queuedSubmission: { id: 'queued', clientUserMessageId } } },
  })
  const submit = () => postCodex(get, 'conversation-action', {
    action: 'prompt', threadId: 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd',
    newSession: { cwd: directory }, mode: 'queue', clientUserMessageId: 'first-attempt',
    input: [{ type: 'text', text: '请核对' }],
  })
  assert.equal((await submit()).status, 400)
  thread = undefined
  rejected = false
  const retried = await submit()
  assert.equal(retried.status, 200)
  assert.equal((await retried.json()).thread.id, 'native-2')
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/queue/add').map(({ params }) => params.threadId),
    ['native-1', 'native-2'])
})

test('明确拒绝入队后复用原 Git 工作树，在改选后使用另一工作树', async t => {
  const threads = new Map()
  let attempts = 0
  const fixture = await fakeCodex(t, {
    'thread/start': ({ cwd, projectId }) => {
      const thread = { id: `native-${threads.size}`, cwd, projectId, status: { type: 'active' } }
      threads.set(thread.id, thread)
      return { result: { thread } }
    },
    'thread/read': ({ threadId }) => ({ result: { thread: threads.get(threadId) } }),
    'thread/queue/add': ({ clientUserMessageId }) => ++attempts < 3
      ? { error: { code: -32602, message: '尚未入队' } }
      : { result: { queuedSubmission: { id: 'queued', clientUserMessageId } } },
  })
  const repo = join(fixture.directory, 'project')
  const existing = join(fixture.directory, 'existing')
  await mkdir(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main')
  git('-c', 'user.name=Draft fixture', '-c', 'user.email=draft@example.test', 'commit', '--allow-empty', '-m', 'Base')
  git('worktree', 'add', '--detach', existing, 'main')

  const get = fixture.openRoutes(join(fixture.directory, 'profile'))
  const worktreeId = '410aab76-b4db-4d05-8fd9-138ce2d07bbf'
  const attempt = { action: 'prompt', threadId: 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd',
    newSession: { cwd: repo, projectId: 'unchanged-project' }, mode: 'queue',
    clientUserMessageId: 'original-attempt', input: [{ type: 'text', text: '待发' }],
    worktree: { kind: 'new', id: worktreeId, baseRef: 'refs/heads/main' } }
  assert.equal((await postCodex(get, 'conversation-action', attempt)).status, 400)
  assert.equal((await postCodex(get, 'conversation-action', attempt)).status, 400)
  const original = threads.get('native-0').cwd
  assert.equal(original, join(fixture.directory, `project-worktree-${worktreeId}`))
  assert.equal(threads.size, 1)

  const sent = await postCodex(get, 'conversation-action', { ...attempt,
    worktree: { kind: 'existing', id: '7348ef67-fd88-4930-ac79-52648f9225cd', path: existing } })
  assert.equal(sent.status, 200)
  assert.equal((await sent.json()).thread.cwd, existing)
  assert.equal(threads.size, 2)
  assert.equal(git('worktree', 'list', '--porcelain').split(`worktree ${original}\n`).length, 2)
})

test('普通文件按内容去重，原生待发和历史引用上传时的快照', async t => {
  const { socketPath, directory, messages } = await fakeCodex(t, {
    'thread/read': ({ threadId }) => ({ result: { thread: { id: threadId, status: { type: 'active' } } } }),
    'thread/queue/add': ({ input, clientUserMessageId }) => {
      queued = { id: 'waiting', input, clientUserMessageId }
      return { result: { queuedSubmission: queued } }
    },
    'thread/queue/list': ({ threadId }) => ['archive', 'other-archive'].includes(threadId)
      ? { error: { code: -32600, message: `session ${threadId} is archived.` } }
      : { result: { data: queued ? [queued] : [] } },
    'thread/queue/delete': () => {
      queued = undefined
      return { result: { deleted: true } }
    },
    'turn/steer': () => ({ error: { code: -32000, message: '未确认回执' } }),
    'thread/queue/update': ({ input }) => {
      queued = { ...queued, input }
      return { result: { queuedSubmission: queued } }
    },
    'thread/items/list': ({ threadId, turnId }) => threadId === 'legacy'
      ? { error: { code: -32601, message: 'list_items is not supported yet' } }
      : { result: { data: threadId === 'main' && turnId === 'turn' ? [{ item: fullHistoryItem() }] : [] } },
    'thread/turns/list': ({ threadId, cursor, itemsView }) => {
      if (threadId === 'main') return { result: { data: [{ id: 'running', status: 'inProgress' }] } }
      assert.equal(threadId, 'legacy')
      assert.equal(itemsView, 'full')
      return { result: cursor ? { data: [{ id: 'turn', items: [fullHistoryItem()] }] }
        : { data: [{ id: 'other-turn', items: [] }], nextCursor: 'older' } }
    },
  })
  let queued
  let historyInput
  const fullHistoryItem = () => ({ type: 'userMessage', id: 'message', content: [historyInput] })
  const makeStore = () => createLocalAttachmentStore(join(directory, 'dsh'))
  const store = await makeStore()
  const owner = new AbortController()
  t.after(() => owner.abort())
  const makeGet = storage => {
    const routes = createHistoryRoutes(socketPath, owner.signal, undefined, storage)
    return (path, options) => routes.find(route => path.split('?')[0] === route.path)
      ?.fetch(new Request(`http://localhost${path}`, options)) ?? Response.json({}, { status: 404 })
  }
  const get = makeGet(store)
  const upload = async (thread, name, body) => {
    const query = new URLSearchParams({ sessionId: thread, name })
    const response = await get(`/api/session/uploadFileBinary?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true, result.error?.message)
    return result.value
  }
  const post = (fields, threadId = 'main') => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, ...fields }),
  })
  const first = await upload('main', '原始 报告.txt', 'version one')
  const same = await upload('main', 'alias.txt', 'version one')
  const next = await upload('main', first.file.name, 'version two')
  assert.equal(first.file.attachmentId, same.file.attachmentId)
  assert.equal((await stat(store.fileHostPath(first.file))).ino, (await stat(store.fileHostPath(same.file))).ino)
  assert.notEqual(first.file.attachmentId, next.file.attachmentId)

  const fields = { action: 'prompt', mode: 'queue', clientUserMessageId: 'web', input: [{ type: 'file', receiptId: first.receiptId }] }
  assert.equal((await post(fields, 'other')).status, 400)
  assert.equal((await post(fields)).status, 200)
  assert.equal(messages.filter(({ method }) => method === 'thread/queue/add').length, 1)
  const saved = queued.input[0]
  assert.equal(saved.type, 'text')
  assert.ok(saved.text.includes(store.fileHostPath(first.file)))
  assert.doesNotMatch(JSON.stringify(saved), /version one/)
  assert.equal((await post({ ...fields, input: [saved] }, 'other')).status, 400)
  const fileQuery = new URLSearchParams({ attachmentId: first.file.attachmentId, name: first.file.name })
  const pendingUrl = '/api/codex/file-download?threadId=main&queuedSubmissionId=waiting&' + fileQuery
  const pending = await get(pendingUrl)
  assert.equal(await pending.text(), 'version one')
  queued.input = [{ type: 'text', text: '来自另一客户端的编辑', text_elements: [] }, saved]
  const edit = await post({ action: 'queue', operation: 'edit', queuedSubmissionId: 'waiting', text: '补充正文' })
  assert.equal(edit.status, 200)
  assert.deepEqual(queued.input, [{ type: 'text', text: '补充正文', text_elements: [] }, saved])
  assert.equal(await (await get(pendingUrl)).text(), 'version one')

  using db = new DatabaseSync(join(directory, 'queue_1.sqlite'))
  db.exec('CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER)')
  const archivedInput = { ...saved,
    text_elements: saved.text_elements.map(({ byteRange, placeholder }) => ({ byte_range: byteRange, placeholder })) }
  const stored = JSON.stringify({ UserInput: { client_id: 'web', content: [archivedInput] } })
  db.prepare('INSERT INTO queued_items VALUES (?, ?, ?, ?)').run('waiting', 'archive', stored, 0)
  const archivedUrl = threadId => `/api/codex/file-download?threadId=${threadId}&queuedSubmissionId=waiting&${fileQuery}`
  const archived = await get(archivedUrl('archive'))
  assert.equal(archived.status, 200)
  assert.equal(await archived.text(), 'version one')
  assert.equal((await get(archivedUrl('other-archive'))).status, 404)
  assert.equal(messages.some(({ method }) => method === 'thread/unarchive'), false)

  const text = '补充正文'
  const offset = Buffer.byteLength(text)
  const { byteRange, placeholder } = saved.text_elements[0]
  historyInput = { type: 'text', text: text + saved.text, text_elements: [
    { byteRange: { start: offset + byteRange.start, end: offset + byteRange.end }, placeholder },
  ] }
  const reopened = makeGet(await makeStore())
  const history = await reopened('/api/codex/file-download?threadId=main&turnId=turn&itemId=message&' + fileQuery)
  assert.equal(history.status, 200)
  assert.match(history.headers.get('content-disposition'), /^attachment;/)
  assert.equal(await history.text(), 'version one')
  const legacy = await reopened('/api/codex/file-download?threadId=legacy&turnId=turn&itemId=message&' + fileQuery)
  assert.equal(legacy.status, 200)
  assert.equal(await legacy.text(), 'version one')
  assert.equal((await reopened('/api/codex/file-download?threadId=other&turnId=turn&itemId=message&' + fileQuery)).status, 404)

  const steer = await post({ action: 'queue', operation: 'steer', queuedSubmissionId: 'waiting', expectedTurnId: 'running' })
  assert.equal(steer.status, 409)
  assert.equal((await steer.json()).reason, 'queue-steer-unknown')
  assert.equal(queued, undefined)
  const uncertain = await get(pendingUrl)
  assert.equal(uncertain.status, 200)
  assert.equal(await uncertain.text(), 'version one')
  assert.equal((await get(archivedUrl('other'))).status, 404)
})

test('网页待发附件的编辑不会在同一条消息插话时静默成功', async t => {
  const file = fileAttachmentInput({ attachmentId: 'sha256:' + 'c'.repeat(64), name: 'report.txt', bytes: 4 }, '/archive/report.txt')
  let queued = { id: 'queued', clientUserMessageId: 'web', input: [file] }
  const readStarted = Promise.withResolvers()
  const letSteerContinue = Promise.withResolvers()
  const editReachedNative = Promise.withResolvers()
  const { get, messages } = await fakeCodex(t, {
    'thread/queue/list': () => ({ result: { data: queued ? [queued] : [] } }),
    'thread/read': async () => {
      readStarted.resolve()
      await letSteerContinue.promise
      return { result: { thread: { id: 'main', status: { type: 'active' } } } }
    },
    'thread/turns/list': () => ({ result: { data: [{ id: 'running', status: 'inProgress' }] } }),
    'thread/queue/update': ({ input }) => {
      queued = { ...queued, input }
      editReachedNative.resolve()
      return { result: { queuedSubmission: queued } }
    },
    'thread/queue/delete': () => {
      queued = undefined
      return { result: { deleted: true } }
    },
    'turn/steer': () => ({ result: { turnId: 'running' } }),
  })
  const change = (operation, fields) => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'main', action: 'queue', queuedSubmissionId: 'queued', operation, ...fields }),
  })
  const steering = change('steer', { expectedTurnId: 'running' })
  await readStarted.promise
  const editing = change('edit', { text: '不应确认未发送的正文' })
  await Promise.race([editReachedNative.promise, delay(50)])
  letSteerContinue.resolve()
  const [steered, edited] = await Promise.all([steering, editing])
  assert.equal(steered.status, 200)
  assert.equal(edited.status, 409)
  assert.deepEqual(messages.find(({ method }) => method === 'turn/steer').params.input, [file])
})

test('Markdown 导出用原生分页读取归档会话的全部已保存内容', async t => {
  let rollout
  const { socketPath, messages, directory } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'archive', name: '仓库整理', path: rollout, archived: true, status: { type: 'notLoaded' } } } }),
    'thread/turns/list': ({ cursor }) => ({ result: cursor ? {
      data: [{ id: 'older', status: 'completed', items: [
        { type: 'userMessage', id: 'question', startedAtMs: 1, content: [{ type: 'text', text: '最早的问题' }, { type: 'image', url: 'data:image/png;base64,AA==' }] },
        { type: 'commandExecution', id: 'command', command: 'git status', startedAtMs: 2, status: 'completed', aggregatedOutput: 'working tree clean' },
      ] }], nextCursor: null,
    } : {
      data: [{ id: 'newer', status: 'inProgress', items: [{ type: 'agentMessage', id: 'answer', text: '最近的回复\n\n```js\nconst x = 1\n```' }] }],
      nextCursor: 'older-page',
    } }),
  })
  rollout = join(directory, 'archive.jsonl')
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'older' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'cancelled', arguments: '{"cmd":"pwd"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cancelled', output: 'aborted by user' } },
  ]
  await writeFile(rollout, rows.map(row => JSON.stringify({ timestamp: '2026-11-23T00:00:00Z', ...row })).join('\n') + '\n')
  const { createSessionExportRoute } = await import('../src/host/session-export.mjs')
  const { formatCodexMarkdown } = await import('../src/host/session-markdown.mjs')
  const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const { formatSessionMarkdown } = await import(requireDsh.resolve('@deepseek-ai/dsh-session-log-export'))
  const route = createSessionExportRoute(socketPath, undefined,
    (thread, turns, cancelled) => formatCodexMarkdown(thread, turns, formatSessionMarkdown, cancelled))
  const response = await route.fetch(new Request('http://localhost/api/codex/session-export?threadId=archive'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8')
  const markdown = await response.text()
  assert.match(markdown, /^# 仓库整理\n/)
  assert.match(markdown, /最早的问题[\s\S]+图片附件[\s\S]+git status[\s\S]+working tree clean[\s\S]+aborted by user[\s\S]+最近的回复/)
  assert.match(markdown, /```js\nconst x = 1\n```/)
  assert.doesNotMatch(markdown, /base64/)
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method }) => method),
    ['thread/read', 'thread/turns/list', 'thread/turns/list'])
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/turns/list').map(({ params }) => params.cursor),
    [undefined, 'older-page'])
})

test('Markdown 导出运行中的旧会话只读取已保存的 rollout 轮次', async t => {
  const legacy = { id: 'legacy-active', historyMode: 'legacy', status: { type: 'active' } }
  const saved = { id: 'saved', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: '已写入的片段' }] }
  const { socketPath, messages } = await fakeCodex(t, {
    'thread/read': ({ includeTurns }) => ({ result: { thread: { ...legacy, turns: includeTurns ? [saved] : [] } } }),
    'thread/turns/list': () => ({ result: { data: [{ ...saved, items: [{ ...saved.items[0], text: '尚未落盘的片段' }] }] } }),
  })
  const { createSessionExportRoute } = await import('../src/host/session-export.mjs')
  const route = createSessionExportRoute(socketPath, undefined, (_, turns) => turns[0].items[0].text)
  const response = await route.fetch(new Request('http://localhost/api/codex/session-export?threadId=legacy-active'))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '已写入的片段')
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method, params }) => [method, params.includeTurns]),
    [['thread/read', undefined], ['thread/read', true]])

  // Native CLI may launch another turn between the summary and the first history page.
  legacy.status.type = 'idle'
  const changed = await route.fetch(new Request('http://localhost/api/codex/session-export?threadId=legacy-active'))
  assert.equal(changed.status, 200)
  assert.equal(await changed.text(), '已写入的片段')
})

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

test('首发计划模式从原生创建连接确认，发送后立即释放订阅', async t => {
  let thread
  let creation
  let planSelected = false
  const { directory, get, messages } = await fakeCodex(t, {
    'thread/start': ({ cwd }, client) => {
      creation = client
      thread = { id: 'main', cwd, status: { type: 'idle' }, model: 'current-model' }
      return { result: { thread } }
    },
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'collaborationMode/list': () => ({ result: { data: [{ mode: 'default' }, { mode: 'plan' }] } }),
    'thread/settings/update': ({ collaborationMode }) => {
      planSelected = collaborationMode.mode === 'plan'
      creation.send(JSON.stringify({ method: 'thread/settings/updated', params: {
        threadId: 'main', threadSettings: { collaborationMode },
      } }))
      return { result: {} }
    },
    'thread/queue/add': () => {
      assert.equal(planSelected, true)
      thread.status.type = 'active'
      return { result: { queuedSubmission: { id: 'queued' } } }
    },
  })
  const response = await postCodex(get, 'conversation-action', {
    action: 'prompt', mode: 'queue', threadId: 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd',
    newSession: { cwd: directory }, clientUserMessageId: 'plan-first', planMode: 'plan',
    input: [{ type: 'text', text: '制定计划' }],
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).planMode, 'plan')
  if (creation.readyState < 2) await once(creation, 'close', { signal: AbortSignal.timeout(1_000) })
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

test('带正文的计划提交先确认原生模式，再进入原生队列', async t => {
  const thread = { id: 'main', name: '已有会话', status: { type: 'idle' }, model: 'native-model' }
  let supported = false
  let selected
  const queuedInModes = []
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'collaborationMode/list': () => ({ result: { data: supported ? [{ mode: 'plan' }] : [] } }),
    'thread/settings/update': ({ collaborationMode }) => {
      selected = collaborationMode.mode
      return { result: {} }
    },
    'thread/queue/add': () => {
      queuedInModes.push(selected)
      return { result: { queuedSubmission: { id: 'plan-queue' } } }
    },
    'thread/queue/list': () => ({ result: { data: [] } }),
  })
  const send = () => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'main', action: 'prompt', mode: 'queue', planMode: 'plan',
      clientUserMessageId: 'plan-input', input: [{ type: 'text', text: '列出验证步骤' }] }),
  })
  assert.ok(!(await send()).ok)
  assert.equal(messages.some(({ method }) => method === 'thread/queue/add'), false)
  supported = true
  assert.deepEqual(await (await send()).json(), { queuedSubmission: { id: 'plan-queue' }, planMode: 'plan' })
  assert.deepEqual(queuedInModes, ['plan'])
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

test('网页目标发送只替换用户确认过的目标', async t => {
  let goal = { objective: '核对依赖', createdAt: 200, tokenBudget: 40, tokensUsed: 39, status: 'paused' }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: 'idle' } } } }),
    'thread/goal/get': () => ({ result: { goal } }),
    'thread/goal/set': ({ objective, status, tokenBudget }) => {
      goal = { ...goal, objective, status, ...(tokenBudget !== undefined && { tokenBudget }) }
      return { result: { goal } }
    },
  })
  const objective = '核对新依赖'
  const expectedGoal = { objective: goal.objective, createdAt: goal.createdAt }
  assert.equal((await postCommand(get, 'goal-create', { objective })).status, 409)
  assert.equal((await postCommand(get, 'goal-create', { objective, expectedGoal: { ...expectedGoal, createdAt: 100 } })).status, 409)
  assert.equal((await postCommand(get, 'goal-create', { objective, expectedGoal: { objective: goal.objective } })).status, 400)
  assert.equal(goal.createdAt, 200)
  const response = await postCommand(get, 'goal-create', { objective, expectedGoal })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { goal: { objective, status: 'active', tokenBudget: null, tokensUsed: 39, createdAt: 200 } })
  assert.deepEqual(messages.filter(({ method }) => ['thread/goal/set', 'thread/goal/clear'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['thread/goal/set', { threadId: 'main', origin: 'user', objective, status: 'active', tokenBudget: null }],
  ])
})

test('网页编辑目标由 Codex 保留当前阶段和用量', async t => {
  let goal = { objective: '核对依赖', createdAt: 200, status: 'paused', tokenBudget: 40, tokensUsed: 39 }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: 'notLoaded' } } } }),
    'thread/list': () => ({ result: { data: [] } }),
    'thread/goal/get': () => ({ result: { goal } }),
    'thread/goal/set': ({ objective }) => { goal = { ...goal, objective }; return { result: { goal } } },
  })
  const expectedGoal = { objective: goal.objective, createdAt: goal.createdAt }
  const objective = '核对生产依赖'
  assert.equal((await postCommand(get, 'goal-edit', { objective })).status, 400)
  assert.equal((await postCommand(get, 'goal-edit', { objective, expectedGoal: { ...expectedGoal, createdAt: 100 } })).status, 409)
  const response = await postCommand(get, 'goal-edit', { objective, expectedGoal })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { goal: { objective, createdAt: 200, status: 'paused', tokenBudget: 40, tokensUsed: 39 } })
  assert.deepEqual(messages.filter(({ method }) => ['thread/resume', 'thread/goal/set', 'thread/goal/clear'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['thread/goal/set', { threadId: 'main', objective, origin: 'user' }],
  ])
})

test('网页暂停和恢复目标时核对提交时的目标身份', async t => {
  let status = 'active'
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: 'idle' } } } }),
    'thread/goal/get': () => ({ result: { goal: { objective: '核对依赖', createdAt: 200, status } } }),
  })
  const expectedGoal = { objective: '核对依赖', createdAt: 100 }
  assert.equal((await postCommand(get, 'goal-pause', { expectedGoal })).status, 409)
  status = 'paused'
  assert.equal((await postCommand(get, 'goal-resume', { expectedGoal })).status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/goal/set'), false)
})

test('网页受阻目标由 Codex 决定能否恢复', async t => {
  const expectedGoal = { objective: '核对依赖', createdAt: 200 }
  let goal
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'main', status: { type: 'idle' } } } }),
    'thread/goal/get': () => ({ result: { goal } }),
    'thread/goal/set': ({ status }) => {
      if (goal.tokenBudget === null || goal.tokensUsed < goal.tokenBudget) goal = { ...goal, status }
      return { result: { goal } }
    },
  })
  for (const status of ['blocked', 'usageLimited', 'budgetLimited']) {
    const tokenBudget = status === 'budgetLimited' ? 40 : null
    goal = { ...expectedGoal, status, tokenBudget, tokensUsed: 40 }
    const response = await postCommand(get, 'goal-resume', { expectedGoal })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { goal: { ...expectedGoal, tokenBudget, tokensUsed: 40,
      status: status === 'budgetLimited' ? 'budgetLimited' : 'active' } })
  }
  goal = { ...expectedGoal, status: 'complete' }
  assert.equal((await postCommand(get, 'goal-resume', { expectedGoal })).status, 409)
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/goal/set').map(({ params }) => params),
    Array.from({ length: 3 }, () => ({ threadId: 'main', origin: 'user', status: 'active' })))
})

test('网页冷恢复目标后再次核对身份', async t => {
  const thread = { id: 'main', status: { type: 'notLoaded' } }
  let goal = { objective: '核对依赖', createdAt: 200, status: 'paused' }
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => ({ result: { data: [] } }),
    'thread/goal/get': () => ({ result: { goal } }),
    'thread/resume': () => {
      thread.status.type = 'idle'
      goal = { ...goal, createdAt: 300 }
      return { result: { thread } }
    },
  })
  const response = await postCommand(get, 'goal-resume', { expectedGoal: { objective: goal.objective, createdAt: goal.createdAt } })
  assert.equal(response.status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/goal/set'), false)
})

test('网页目标在冷恢复和模型权限生效后才启动原生目标', async t => {
  const thread = { id: 'main', cwd: '/workspace', status: { type: 'notLoaded' }, modelProvider: 'openai', model: 'old' }
  let queued = [{ id: 'previous' }]
  let archived = true
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: archived ? [thread] : [] } }),
    'thread/unarchive': () => { archived = false; return { result: { thread } } },
    'thread/goal/get': () => ({ result: { goal: null } }),
    'thread/queue/list': () => ({ result: { data: queued } }),
    'permissionProfile/list': () => ({ result: { data: [{ id: ':read-only', allowed: true }] } }),
    'thread/resume': params => {
      thread.model = params.model ?? thread.model
      thread.reasoningEffort = params.config?.model_reasoning_effort
      thread.status.type = 'idle'
      return { result: { thread, activePermissionProfile: { id: params.permissions } } }
    },
    'thread/goal/set': ({ objective, status }) => ({ result: { goal: { objective, status } } }),
  })
  const fields = { objective: '核对兼容性', unarchive: true,
    modelDraft: { provider: 'openai', model: 'selected', reasoningEffort: 'high' } }
  assert.equal((await postCommand(get, 'goal-create', { ...fields, permissionDraft: 'unavailable-profile' })).status, 400)
  assert.equal(archived, true)
  const submit = () => postCommand(get, 'goal-create', { ...fields, permissionDraft: ':read-only' })
  assert.equal((await submit()).status, 409)
  assert.equal(messages.some(({ method }) => method === 'thread/resume' || method === 'thread/goal/set'), false)
  queued = []
  const response = await submit()
  assert.equal(response.status, 200)
  const { goal, permission } = await response.json()
  assert.deepEqual(goal, { objective: fields.objective, status: 'active' })
  assert.equal(permission?.profileId, ':read-only')
  assert.deepEqual(messages.filter(({ method }) => ['thread/resume', 'thread/goal/set'].includes(method))
    .map(({ method, params }) => [method, params]), [
    ['thread/resume', { threadId: 'main', excludeTurns: true, permissions: ':read-only', model: 'selected', config: { model_reasoning_effort: 'high' } }],
    ['thread/goal/set', { threadId: 'main', origin: 'user', objective: fields.objective, status: 'active' }],
  ])
  assert.equal(messages.some(({ method }) => method === 'turn/start' || method === 'thread/queue/add'), false)
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

test('目录转为项目时迁移分页中的普通及归档会话，并复用同时添加的项目', async t => {
  const cwd = '/repo/example'
  const threads = [
    { id: 'active', cwd, status: { type: 'active' } },
    { id: 'archived', cwd, archived: true },
    { id: 'nested', cwd: `${cwd}/nested` },
    { id: 'assigned', cwd, projectId: 'other' },
  ]
  const projects = []
  const { get, messages } = await fakeCodex(t, {
    'project/list': async () => {
      const data = projects.slice()
      // 让普通添加和目录转换都能在首个创建完成前进入服务端。
      if (data.length === 0) await delay(30)
      return { result: { data } }
    },
    'project/create': ({ name, roots }) => {
      const project = { id: 'promoted', name, roots }
      projects.push(project)
      return { result: { project } }
    },
    'thread/list': ({ archived, cursor, projectId }) => {
      assert.equal(projectId, null)
      return { result: { data: cursor ? threads.filter(thread => Boolean(thread.archived) === archived && !thread.projectId) : [],
        ...(!cursor && { nextCursor: 'later' }) } }
    },
    'thread/read': ({ threadId }) => ({ result: { thread: threads.find(thread => thread.id === threadId) } }),
    'thread/metadata/update': ({ threadId, projectId }) => {
      const thread = threads.find(thread => thread.id === threadId)
      thread.projectId = projectId
      return { result: { thread } }
    },
  })
  const promote = () => get('/api/codex/project-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'promote', cwd }),
  })
  const [added, ...results] = await Promise.all([
    get('/api/codex/conversation-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'project', cwd }),
    }),
    promote(), promote(),
  ])
  assert.equal(added.status, 200)
  assert.deepEqual((await added.json()).project, projects[0])
  for (const response of results) {
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { projects, workspacePaths: {}, projectId: 'promoted', moved: ['active', 'archived'], failed: [] })
  }
  assert.deepEqual(projects, [{ id: 'promoted', name: 'example', roots: [{ path: cwd }] }])
  assert.deepEqual(threads.map(thread => thread.projectId), ['promoted', 'promoted', undefined, 'other'])
  assert.equal(threads[1].archived, true)
  assert.equal(threads[0].status.type, 'active')
  assert.equal(messages.filter(({ method }) => method === 'thread/metadata/update').length, 2)
  assert.equal(messages.some(({ method }) => method === 'thread/resume' || method === 'thread/unarchive'), false)
})

test('目录转换部分失败后重试，仅向同目录已有项目迁移余下会话', async t => {
  const cwd = '/repo/example'
  const project = { id: 'existing', name: '自定义项目名', roots: [{ path: cwd }] }
  const active = { id: 'active', cwd }
  const archived = { id: 'archived', cwd, archived: true }
  let unavailable = true
  const { get, messages } = await fakeCodex(t, {
    'project/list': () => ({ result: { data: [project] } }),
    'thread/list': (params) => ({ result: { data: [params.archived ? archived : active].filter(thread => !thread.projectId) } }),
    'thread/read': ({ threadId }) => ({ result: { thread: threadId === archived.id ? archived : active } }),
    'thread/metadata/update': ({ threadId, projectId }) => {
      const thread = threadId === archived.id ? archived : active
      if (thread === archived && unavailable) return { error: { code: -32603, message: '暂时无法更新' } }
      thread.projectId = projectId
      return { result: { thread } }
    },
  })
  const promote = () => get('/api/codex/project-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'promote', cwd }),
  })
  const first = await promote()
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { projects: [project], workspacePaths: {}, projectId: project.id,
    moved: [active.id], failed: [{ threadId: archived.id, message: '暂时无法更新' }] })
  unavailable = false
  const retry = await promote()
  assert.equal(retry.status, 200)
  assert.deepEqual(await retry.json(), { projects: [project], workspacePaths: {}, projectId: project.id, moved: [archived.id], failed: [] })
  assert.deepEqual(messages.filter(({ method }) => method === 'thread/metadata/update').map(({ params }) => params.threadId),
    [active.id, archived.id, archived.id])
  assert.equal(messages.some(({ method }) => method === 'project/create'), false)
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

test('会话引用在原生入队前确认模型工具，并按原生格式发送线程 ID', async t => {
  const thread = { id: 'native-thread', cwd: '/mock', status: { type: 'active' } }
  let connected = false
  let queued
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'mcpServerStatus/list': ({ serverName }) => ({ result: { data: connected && serverName === codexTaskToolsServerName
      ? [{ name: serverName, runtimeStatus: 'connected', tools: { read_thread: {} } }] : [] } }),
    'thread/queue/add': ({ input }) => {
      queued = { id: 'reference-queued', input }
      return { result: { queuedSubmission: queued } }
    },
    'thread/queue/list': () => ({ result: { data: queued ? [queued] : [] } }),
    'thread/queue/start': () => ({ result: { turn: { id: 'continued-reference' } } }),
  })
  const text = '参考 ' + encodeThreadReference('source-thread', '旧会话')
  const fields = { action: 'prompt', threadId: thread.id, mode: 'queue',
    clientUserMessageId: 'reference-input', input: [{ type: 'text', text }] }
  const blocked = await postCodex(get, 'conversation-action', fields)
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).reason, 'thread-read-tool-unavailable')
  assert(!messages.some(({ method }) => method === 'thread/queue/add'))
  connected = true
  const sent = await postCodex(get, 'conversation-action', fields)
  assert.equal(sent.status, 200)
  const { queuedSubmission } = await sent.json()
  assert.match(queuedSubmission.input[0].text, /"threadId":"source-thread"/)
  assert(queuedSubmission.input[0].text.endsWith(text))
  assert.deepEqual(queuedSubmission.input[0].text_elements.map(element => element.placeholder), ['@旧会话'])

  thread.status.type = 'idle'
  connected = false
  const resume = { action: 'queue', operation: 'start', threadId: thread.id }
  assert.equal((await postCodex(get, 'conversation-action', resume)).status, 409)
  assert(!messages.some(({ method }) => method === 'thread/queue/start'))
  connected = true
  assert.equal((await postCodex(get, 'conversation-action', resume)).status, 200)
  assert.equal(messages.find(({ method }) => method === 'thread/queue/start').params.queuedSubmissionId, queued.id)
})

test('中断后空闲发送会启动唯一的新稿，既有待发消息仍由继续队列控制', async t => {
  const cases = [
    { name: '启动暂停队列中唯一的新稿', pending: [] },
    { name: '保留此前暂停的队列', pending: [{ id: 'old', clientUserMessageId: 'held' }] },
    { name: '初次读取后轮次中断，仍能启动新稿', pending: [], wasActive: true },
    { name: '本页尚未看到其他客户端启动的轮次，向浏览器确认队首仍在等待', pending: [], becameActive: true },
  ]
  for (const { name, pending, wasActive, becameActive } of cases) {
    await t.test(name, async t => {
      const threadId = 'idle-after-interrupt'
      const queued = [...pending]
      let status = wasActive ? 'active' : 'idle'
      const { get, messages } = await fakeCodex(t, {
        'thread/read': () => ({ result: { thread: { id: threadId, status: { type: status } } } }),
        'thread/queue/add': params => {
          status = becameActive ? 'active' : 'idle'
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
          clientUserMessageId: 'browser', input: [{ type: 'text', text: '新消息' }], reportQueuedForLater: true,
        }),
      })
      assert.equal(response.status, 200)
      assert.equal(messages.some(({ method }) => method === 'turn/steer'), false)
      const waiting = Boolean(pending.length || becameActive)
      assert.equal(messages.some(({ method }) => method === 'thread/queue/start'), !waiting)
      assert.equal((await response.json()).queuedForLater === true, waiting)
      assert.deepEqual(queued.map(({ id }) => id), waiting ? [...pending.map(({ id }) => id), 'new'] : [])
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

test('旧版查看队列请求也不能解除归档', async t => {
  const thread = { id: 'archive-queue-view', status: { type: 'notLoaded' } }
  let archived = true
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': () => ({ result: { data: archived ? [thread] : [] } }),
    'thread/unarchive': () => { archived = false; return { result: { thread } } },
    'thread/queue/list': () => archived ? { error: { code: -32600, message: 'session is archived' } }
      : { result: { data: [], nextCursor: null } },
  })
  const list = unarchive => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'queue', operation: 'list', threadId: thread.id, unarchive,
    }),
  })
  assert.equal((await list(true)).status, 400)
  assert.equal(archived, true)
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method }) => method),
    ['thread/queue/list'])
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

test('继续归档队列时只在待核对的原始队首已离开后启动下一项', async t => {
  const thread = { id: 'thread', status: { type: 'active' } }
  const turn = { id: 'running', status: 'inProgress', items: [] }
  const uncertain = { id: 'first', clientUserMessageId: 'first-msg', input: [{ type: 'text', text: 'A' }] }
  const next = { id: 'next', clientUserMessageId: 'next-msg', input: [{ type: 'text', text: 'B' }] }
  let queue = [uncertain, next]
  let archived = false
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { ...thread, archived } } }),
    'thread/list': () => ({ result: { data: archived ? [thread] : [] } }),
    'thread/unarchive': () => {
      archived = false
      return { result: { thread } }
    },
    'thread/queue/list': () => archived ? { error: { code: -32600, message: 'session is archived' } }
      : { result: { data: queue } },
    'thread/queue/delete': (_, client) => {
      client.terminate()
    },
    'thread/resume': () => {
      thread.status = { type: 'active' }
      return { result: { thread } }
    },
    'thread/turns/list': () => ({ result: { data: [turn] } }),
    'thread/queue/start': () => ({ result: { started: true } }),
  })
  const post = (operation, fields) => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'queue', operation, threadId: thread.id, ...fields }),
  })
  const unknown = await post('steer', { queuedSubmissionId: uncertain.id, expectedTurnId: turn.id })
  assert.equal((await unknown.json()).reason, 'queue-steer-unknown')

  archived = true
  thread.status = { type: 'notLoaded' }
  const blocked = await post('start', { unarchive: true })
  assert.equal((await blocked.json()).reason, 'queue-steer-unknown')
  assert.equal(archived, false)
  assert.equal(messages.some(({ method }) => ['thread/resume', 'thread/queue/start'].includes(method)), false)

  archived = true
  queue = [next]
  const before = messages.length
  assert.deepEqual(await (await post('start', { unarchive: true })).json(), { started: true })
  const operations = messages.slice(before).filter(({ method }) =>
    ['thread/unarchive', 'thread/queue/list', 'thread/resume', 'thread/queue/start'].includes(method))
  assert.deepEqual(operations.map(({ method }) => method), ['thread/unarchive', 'thread/queue/list', 'thread/resume', 'thread/queue/start'])
  assert.equal(operations.at(-1).params.queuedSubmissionId, next.id)

  queue = []
  const beforeEmpty = messages.length
  assert.deepEqual(await (await post('start', {})).json(), { queueEmpty: true })
  assert.equal(messages.slice(beforeEmpty).some(({ method }) => method === 'thread/queue/start'), false)
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
  assert.deepEqual(messages.at(-1).params, { threadId, queuedSubmissionId: item.id })
})

test('待发项从原生队列移除后保留完整原稿，直到重连在指定历史中看到原生 ID', async t => {
  for (const outcome of ['删除回执丢失', '插话回执丢失', '原生先领取待发项']) {
    await t.test(outcome, async t => {
      const item = { id: 'queued-id', clientUserMessageId: 'queued-client-id', input: [
        { type: 'text', text: '待发正文', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,AA==' },
        { type: 'localImage', path: '/mock/image.png' },
      ] }
      const other = { id: 'other', clientUserMessageId: 'other-client-id', input: [item.input[0]] }
      const queued = [item, other]
      const target = { id: 'target', status: 'inProgress', items: [] }
      let holdQueueRead = outcome === '插话回执丢失'
      const readStarted = Promise.withResolvers()
      const replyToOldRead = Promise.withResolvers()
      t.after(() => replyToOldRead.resolve())
      const { get, messages } = await fakeCodex(t, {
        'thread/read': () => ({ result: { thread: { id: 'thread', status: { type: 'active' } } } }),
        'thread/turns/list': ({ cursor, limit }) => ({ result: limit === 1 || cursor
          ? { data: [target] } : { data: [{ id: 'newer', status: 'inProgress', items: [] }], nextCursor: 'earlier' } }),
        'thread/queue/list': async () => {
          const data = [...queued]
          if (holdQueueRead) {
            holdQueueRead = false
            readStarted.resolve()
            await replyToOldRead.promise
          }
          return { result: { data } }
        },
        'thread/queue/delete': ({ queuedSubmissionId }, client) => {
          assert.equal(queuedSubmissionId, item.id)
          queued.shift()
          if (outcome === '删除回执丢失') client.terminate()
          return { result: { deleted: outcome !== '原生先领取待发项' } }
        },
        'turn/steer': ({ input, clientUserMessageId }, client) => {
          assert.deepEqual(input, item.input)
          assert.equal(clientUserMessageId, item.clientUserMessageId)
          client.terminate()
          return { result: { turnId: target.id } }
        },
      })
      const post = (operation, fields = {}) => get('/api/codex/conversation-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'queue', threadId: 'thread', operation, ...fields }),
      })
      const steer = () => post('steer', { queuedSubmissionId: item.id, expectedTurnId: target.id })
      const stale = holdQueueRead ? post('list') : undefined
      if (stale) await readStarted.promise
      const response = await steer()
      assert.equal(response.status, 409)
      assert.equal((await response.json()).reason, 'queue-steer-unknown')
      target.items = [{ type: 'userMessage', clientId: 'different', content: item.input }]
      if (stale) {
        replyToOldRead.resolve()
        assert.deepEqual(await (await stale).json(), { data: [other], steers: [{ item, status: 'unconfirmed' }] })
      }
      assert.deepEqual(await (await post('list')).json(), { data: [other], steers: [{ item, status: 'unconfirmed' }] })
      assert.equal((await steer()).status, 409)
      assert.equal((await post('restore-steer', { queuedSubmissionId: item.id })).status, 409)
      assert.equal(messages.filter(({ method }) => method === 'thread/queue/delete').length, 1)
      assert.equal(messages.filter(({ method }) => method === 'turn/steer').length, Number(outcome === '插话回执丢失'))
      assert.equal(messages.some(({ method }) => method === 'thread/queue/add'), false)

      target.items = [{ type: 'userMessage', clientId: item.clientUserMessageId, content: item.input }]
      assert.deepEqual(await (await post('list')).json(), { data: [other] })
    })
  }
})

test('插话进行时队列流保留待发项，网页请求取消后仍可确认送达', async t => {
  const item = { id: 'queued', clientUserMessageId: 'client-id', input: [{ type: 'text', text: '原稿' }] }
  const target = { id: 'target', status: 'inProgress', items: [] }
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const oldReadEntered = Promise.withResolvers()
  const oldReadFinish = Promise.withResolvers()
  let holdOldRead = false
  let queue = [item]
  let queueAvailable = true
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'thread', status: { type: 'active' } } } }),
    'thread/turns/list': () => ({ result: { data: [target] } }),
    'thread/queue/list': async () => {
      if (!queueAvailable) return { error: { code: -32600, message: '暂时无法读取原生队列' } }
      const data = queue
      if (holdOldRead) {
        holdOldRead = false
        oldReadEntered.resolve()
        await oldReadFinish.promise
      }
      return { result: { data } }
    },
    'thread/queue/delete': () => {
      queue = []
      return { result: { deleted: true } }
    },
    'turn/steer': async () => {
      entered.resolve()
      await finish.promise
      return { result: { turnId: target.id } }
    },
  })
  t.after(() => finish.resolve())
  t.after(() => oldReadFinish.resolve())
  const watch = await fixture.get('/api/codex/watch?threadId=thread&queue=1', { signal: AbortSignal.timeout(2_000) })
  const reader = watch.body.getReader()
  t.after(() => reader.cancel())
  const queueFrame = async () => {
    while (true) {
      const frame = await reader.read()
      assert.equal(frame.done, false)
      const payload = Buffer.from(frame.value).toString()
      if (!payload.startsWith('data: ')) continue
      const parsed = JSON.parse(payload.slice(6))
      if (parsed.type === 'queue') return parsed
    }
  }
  assert.deepEqual((await queueFrame()).submissions, [item])

  holdOldRead = true
  const stale = fixture.get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'queue', operation: 'list', threadId: 'thread' }),
  })
  await oldReadEntered.promise
  const abort = new AbortController()
  const steer = signal => fixture.get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ action: 'queue', operation: 'steer', threadId: 'thread',
      queuedSubmissionId: item.id, expectedTurnId: target.id }),
  })
  const first = steer(abort.signal)
  await entered.promise
  queueAvailable = false
  assert.deepEqual((await queueFrame()).steers, [{ item, status: 'steering' }])
  abort.abort()
  const duplicate = steer()
  queueAvailable = true
  finish.resolve()
  assert.equal((await first).status, 200)
  assert.equal((await duplicate).status, 409)
  oldReadFinish.resolve()
  assert.deepEqual(await (await stale).json(), { data: [] })
  assert.deepEqual(await queueFrame(), { type: 'queue', submissions: [] })
  assert.deepEqual(fixture.messages.filter(({ method }) => ['thread/queue/delete', 'turn/steer'].includes(method))
    .map(({ method }) => method), ['thread/queue/delete', 'turn/steer'])
})

test('暂时读不到队列时保留确定在队列中的原稿', async t => {
  for (const outcome of ['删除被拒绝', '插话被拒绝后重新入队']) await t.test(outcome, async t => {
    const item = { id: 'queued', clientUserMessageId: 'client-id', input: [{ type: 'text', text: '正文' }] }
    const restored = { ...item, id: 'restored' }
    const entered = Promise.withResolvers()
    const finish = Promise.withResolvers()
    let queueAvailable = true
    const rejectDelete = outcome === '删除被拒绝'
    const { get } = await fakeCodex(t, {
      'thread/read': () => ({ result: { thread: { id: 'thread', status: { type: 'active' } } } }),
      'thread/turns/list': () => ({ result: { data: [{ id: 'target', status: 'inProgress', items: [] }] } }),
      'thread/queue/list': () => queueAvailable ? { result: { data: [item] } }
        : { error: { code: -32600, message: '暂时无法读取原生队列' } },
      'thread/queue/delete': async () => {
        entered.resolve()
        await finish.promise
        return rejectDelete ? { error: { code: -32600, message: '原生拒绝删除' } } : { result: { deleted: true } }
      },
      'turn/steer': () => ({ error: { code: -32600, message: 'no active turn to steer' } }),
      'thread/queue/add': () => ({ result: { queuedSubmission: restored } }),
    })
    t.after(() => finish.resolve())
    const watch = await get('/api/codex/watch?threadId=thread&queue=1', { signal: AbortSignal.timeout(2_000) })
    const reader = watch.body.getReader()
    t.after(() => reader.cancel())
    const queueFrame = async () => {
      while (true) {
        const { value, done } = await reader.read()
        assert.equal(done, false)
        const payload = Buffer.from(value).toString()
        if (!payload.startsWith('data: ')) continue
        const frame = JSON.parse(payload.slice(6))
        if (frame.type === 'queue') return frame
      }
    }
    assert.deepEqual((await queueFrame()).submissions, [item])
    const operation = get('/api/codex/conversation-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'queue', operation: 'steer', threadId: 'thread',
        queuedSubmissionId: item.id, expectedTurnId: 'target' }),
    })
    await entered.promise
    queueAvailable = false
    assert.deepEqual((await queueFrame()).steers, [{ item, status: 'steering' }])
    finish.resolve()
    assert.equal((await operation).status, rejectDelete ? 400 : 409)
    assert.deepEqual(await queueFrame(), { type: 'queue', submissions: [rejectDelete ? item : restored] })
  })
})

test('原生插话回执丢失时按保留的异步问题身份避免重复答复', async t => {
  const thread = { id: 'thread', status: { type: 'active' }, historyMode: 'legacy' }
  const question = { id: 'ask', type: 'agentMessage', questions: [{ title: '要继续吗？' }] }
  const turn = { id: 'target', status: 'inProgress', items: [question] }
  const input = [{ type: 'text', text: encodeQuestionReplies([
    { questionItemId: asyncQuestionItemId(question.id, 0), question: '要继续吗？', answer: '要' },
  ]) }]
  let queue = [{ id: 'reply', clientUserMessageId: 'client-id', input }]
  let steers = 0
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/turns/list': () => ({ result: { data: [turn] } }),
    'thread/queue/list': () => ({ result: { data: queue } }),
    'thread/queue/delete': () => { queue = []; return { result: { deleted: true } } },
    'turn/steer': (_, client) => {
      if (++steers === 1) client.terminate()
      return { result: { turnId: turn.id } }
    },
  })
  const post = (route, body) => get(`/api/codex/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: thread.id, ...body }),
  })
  const first = await post('conversation-action', { action: 'queue', operation: 'steer', queuedSubmissionId: 'reply', expectedTurnId: turn.id })
  assert.equal((await first.json()).reason, 'queue-steer-unknown')
  const response = await post('async-question-answer', { turnId: turn.id, itemId: question.id, answers: [{ index: 0, answer: '不要' }] })
  assert.deepEqual(await response.json(), { submitted: false })
  assert.equal(steers, 1)
  assert.equal(messages.some(({ method }) => method === 'thread/queue/add'), false)
})

test('插话明确拒绝且恢复失败时才允许手动恢复原生队列', async t => {
  const item = { id: 'queued', clientUserMessageId: 'client-id', input: [{ type: 'text', text: '正文' },
    { type: 'image', url: 'data:image/png;base64,AA==' }] }
  const restored = { ...item, id: 'restored' }
  let queue = [item]
  let allowRestore = false
  const restoring = Promise.withResolvers()
  const finish = Promise.withResolvers()
  t.after(() => finish.resolve())
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'thread', status: { type: 'active' } } } }),
    'thread/turns/list': () => ({ result: { data: [{ id: 'target', status: 'inProgress', items: [] }] } }),
    'thread/queue/list': () => ({ result: { data: queue } }),
    'thread/queue/delete': () => {
      queue = []
      return { result: { deleted: true } }
    },
    'turn/steer': () => ({ error: { code: -32600, message: 'no active turn to steer' } }),
    'thread/queue/add': async params => {
      assert.deepEqual(params, { threadId: 'thread', input: item.input, clientUserMessageId: item.clientUserMessageId })
      if (!allowRestore) return { error: { code: -32600, message: '无法入队' } }
      queue = [restored]
      restoring.resolve()
      await finish.promise
      return { result: { queuedSubmission: restored } }
    },
  })
  const post = operation => get('/api/codex/conversation-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'queue', operation, threadId: 'thread', queuedSubmissionId: item.id, expectedTurnId: 'target' }),
  })
  assert.equal((await post('steer')).status, 409)
  assert.deepEqual(await (await post('list')).json(), { data: [], steers: [{ item, status: 'recoverable' }] })
  allowRestore = true
  const request = post('restore-steer')
  await restoring.promise
  assert.deepEqual(await (await post('list')).json(), { data: [], steers: [{ item, status: 'steering' }] })
  finish.resolve()
  assert.equal((await request).status, 200)
  assert.deepEqual(await (await post('list')).json(), { data: [restored] })
  assert.equal((await post('restore-steer')).status, 409)
  assert.equal(messages.filter(({ method }) => method === 'thread/queue/add').length, 2)
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
  const { get, messages, socketPath } = await fakeCodex(t, {
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
    ['thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true, config: codexTaskToolsConfig(socketPath) }],
    ['thread/fork', { threadId: source.id, excludeTurns: true, deferGoalContinuation: true, lastTurnId: 'earlier',
      config: codexTaskToolsConfig(socketPath) }],
  ])
})

test('归档会话明确提交改名时才取消归档，保持原线程未加载', async t => {
  const thread = { id: 'archived-rename', name: '旧名称', status: { type: 'notLoaded' } }
  let archived = true
  const { get, messages } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread } }),
    'thread/list': ({ archived: onlyArchived, includedThreadIds }) => ({ result: {
      data: archived && onlyArchived && includedThreadIds.includes(thread.id) ? [thread] : [],
    } }),
    'thread/unarchive': () => { archived = false; return { result: { thread } } },
    'thread/name/set': ({ name }) => {
      if (archived) return { error: { code: -32600, message: 'no rollout found for thread id' } }
      thread.name = name
      return { result: {} }
    },
  })
  const rename = unarchive => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      threadId: thread.id, action: 'rename', name: '新名称', ...(unarchive && { unarchive: true }),
    }),
  })
  assert.equal((await rename(false)).status, 400)
  assert.equal(archived, true)
  assert.equal(thread.name, '旧名称')
  assert.equal((await rename(true)).status, 200)
  assert.equal(archived, false)
  assert.equal(thread.name, '新名称')
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method }) => method),
    ['thread/name/set', 'thread/read', 'thread/list', 'thread/unarchive', 'thread/name/set'])
})

test('已归档源会话收到明确确认后才取消归档，并直接使用原生分叉', async t => {
  const source = { id: 'archived-source', cwd: '/mock', status: { type: 'notLoaded' } }
  const branch = { id: 'forked-thread', cwd: source.cwd, forkedFromId: source.id }
  let archived = true
  const { get, messages, socketPath } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: source } }),
    'thread/list': ({ archived: filter, includedThreadIds }) => ({ result: {
      data: filter && archived && includedThreadIds.includes(source.id) ? [source] : [],
    } }),
    'thread/unarchive': () => { archived = false; return { result: { thread: source } } },
    'thread/fork': () => archived ? { error: { code: -32600, message: 'source is archived' } } : { result: { thread: branch } },
  })
  const fork = unarchive => get('/api/codex/thread-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      threadId: source.id, action: 'fork', lastTurnId: 'selected-turn', ...(unarchive && { unarchive: true }),
    }),
  })
  const refused = await fork(false)
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).error, 'source is archived')
  assert.equal(archived, true)
  const result = await fork(true)
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).thread, branch)
  assert.equal(archived, false)
  assert.deepEqual(messages.filter(({ method }) => method.startsWith('thread/')).map(({ method }) => method),
    ['thread/fork', 'thread/read', 'thread/list', 'thread/unarchive', 'thread/fork'])
  assert.deepEqual(messages.at(-1).params, {
    threadId: source.id, lastTurnId: 'selected-turn', excludeTurns: true, deferGoalContinuation: true,
    config: codexTaskToolsConfig(socketPath),
  })
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
    'config/read': ({ cwd }) => ({ result: { config: cwd === '/workspace'
      ? { model_provider: 'first', model: 'other', model_reasoning_effort: 'xhigh' } : {} } }),
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
  const workspace = await get('/api/codex/models?cwd=%2Fworkspace')
  assert.equal(workspace.status, 200)
  assert.deepEqual((await workspace.json()).default, { provider: 'first', model: 'other', reasoningEffort: 'xhigh' })
  assert.equal(messages.some(({ method }) => ['thread/start', 'thread/resume'].includes(method)), false)
})

test('Profile 默认模型随设置保存，并应用于各新会话的首次原生操作', async t => {
  const threads = new Map()
  const { openRoutes, directory, messages } = await fakeCodex(t, {
    'config/read': () => ({ result: { config: { model: 'native', model_reasoning_effort: 'low' } } }),
    'modelProvider/list': () => ({ result: { data: [{ id: 'test', name: 'Provider' }], defaultProviderId: 'test' } }),
    'model/list': () => ({ result: { data: ['native', 'saved', 'explicit'].map(model => ({
      model, displayName: model, defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })),
    })) } }),
    'thread/start': ({ cwd, model, modelProvider, config }) => {
      const thread = { id: `native-${threads.size}`, cwd, model, modelProvider,
        reasoningEffort: config?.model_reasoning_effort, status: { type: 'idle' } }
      threads.set(thread.id, thread)
      return { result: { thread } }
    },
    'thread/read': ({ threadId }) => ({ result: { thread: threads.get(threadId) } }),
    'thread/queue/add': () => ({ result: {} }),
    'thread/goal/get': () => ({ result: { goal: null } }),
    'thread/goal/set': ({ objective }) => ({ result: { goal: { objective, status: 'active' } } }),
    'review/start': ({ threadId }) => {
      threads.get(threadId).status = { type: 'active' }
      return { result: { turn: { id: 'review' }, reviewThreadId: threadId } }
    },
  })
  const profile = join(directory, 'profile')
  const otherProfile = openRoutes(join(directory, 'other-profile'))
  const writable = openRoutes(profile)
  const modelDefault = '/api/codex/model-default'
  const workspaceModels = `/api/codex/models?${new URLSearchParams({ cwd: directory })}`
  const selection = { provider: 'test', model: 'saved', reasoningEffort: 'high' }
  const native = { provider: 'test', model: 'native', reasoningEffort: 'low' }
  assert.equal((await writable(modelDefault)).status, 200)
  assert.deepEqual(await (await writable(modelDefault)).json(), { selection: null })
  assert.equal((await postCodex(writable, 'model-default', { selection })).status, 200)

  const get = openRoutes(profile)
  assert.deepEqual(await (await get(modelDefault)).json(), { selection })
  assert.deepEqual((await (await get(workspaceModels)).json()).default, selection)
  assert.deepEqual((await (await otherProfile(workspaceModels)).json()).default, native)
  assert.equal((await postCodex(get, 'model-default', { selection: { ...selection, reasoningEffort: 'unavailable' } })).status, 400)
  assert.deepEqual(await (await get(modelDefault)).json(), { selection })
  assert.equal(messages.some(({ method }) => method === 'thread/start' || method === 'config/batchWrite'), false)

  const newSession = { cwd: directory }
  const submit = (route, fields) => postCodex(get, route, {
    threadId: 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd', newSession, clientUserMessageId: fields.action, ...fields,
  })
  const prompt = await submit('conversation-action', { action: 'prompt', mode: 'queue', input: [{ type: 'text', text: '首次发送' }] })
  assert.equal(prompt.status, 200, await prompt.text())
  const goal = await submit('command-action', { action: 'goal-create', objective: '首次创建目标' })
  assert.equal(goal.status, 200, await goal.text())
  const review = await submit('command-action', { action: 'review', target: { type: 'uncommittedChanges' },
    modelDraft: { ...selection, model: 'explicit', reasoningEffort: 'low' } })
  assert.equal(review.status, 200, await review.text())
  const starts = messages.filter(({ method }) => method === 'thread/start').map(({ params }) =>
    [params.modelProvider, params.model, params.config?.model_reasoning_effort])
  assert.deepEqual(starts, [['test', 'saved', 'high'], ['test', 'saved', 'high'], ['test', 'explicit', 'low']])

  assert.equal((await postCodex(get, 'model-default', { selection: null })).status, 200)
  assert.deepEqual((await (await get(workspaceModels)).json()).default, native)

  assert.equal((await postCodex(get, 'model-default', { selection: { reasoningEffort: 'high' } })).status, 200)
  assert.deepEqual((await (await get(workspaceModels)).json()).default, { ...native, reasoningEffort: 'high' })
  const effortOnly = await submit('conversation-action', { action: 'prompt', clientUserMessageId: 'effort-only',
    mode: 'queue', input: [{ type: 'text', text: '使用 Codex 模型和网页强度' }] })
  assert.equal(effortOnly.status, 200, await effortOnly.text())
  const { params } = messages.findLast(({ method }) => method === 'thread/start')
  assert.equal(params.model, undefined)
  assert.equal(params.modelProvider, undefined)
  assert.equal(params.config?.model_reasoning_effort, 'high')
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

test('SSE 积压达到字节上限时释放当前连接的监听和待发数据', { timeout: 5000 }, async t => {
  const { socketPath, clientClosed } = await fakeCodex(t, {})
  const observing = Promise.withResolvers()
  const route = createWatchRoute(socketPath, undefined, undefined, {
    watch(send, signal) { observing.resolve({ send, signal }) },
  })
  const response = await route.fetch(new Request('http://localhost/api/codex/watch?scope=catalog&backgroundTerminals=1'))
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"catalog-ready"}\n\n')
  const { send, signal } = await observing.promise
  const update = { type: 'background-terminals', byThread: { example: '摘要'.repeat(131_072) } }
  send(update)
  send(update)
  assert.equal(signal.aborted, false)
  send(update)
  assert.equal(signal.aborted, true)
  assert.equal((await reader.read()).done, true)
  await clientClosed
})

test('目录读回阻塞时限制等待处理的原生通知', { timeout: 2000 }, async t => {
  const reading = Promise.withResolvers()
  const reply = Promise.withResolvers()
  const { get, broadcast, clientClosed } = await fakeCodex(t, {
    'thread/read': () => { reading.resolve(); return reply.promise },
  })
  t.after(() => reply.resolve({ result: { thread: { id: 'session' } } }))
  const reader = (await get('/api/codex/watch?scope=catalog')).body.getReader()
  t.after(() => reader.cancel())
  assert.match(new TextDecoder().decode((await reader.read()).value), /catalog-ready/)
  broadcast({ method: 'thread/status/changed', params: { threadId: 'session', status: { type: 'active' } } })
  await reading.promise

  const readState = { firstUnread: null, revision: '版本'.repeat(131_072) }
  for (const threadId of ['first', 'second', 'third']) {
    broadcast({ method: 'thread/readState/changed', params: { threadId, readState } })
  }
  assert.equal((await reader.read()).done, true)
  await clientClosed
})

test('首个快照尚未读完时原生连接断开会立即释放观察', { timeout: 2000 }, async t => {
  let upstream
  const { socketPath } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'large', historyMode: 'paginated' } } }),
    'thread/turns/list': (_, client) => {
      upstream = client
      return { result: { data: [{ id: 'turn', status: 'completed', items: [
        { id: 'reply', type: 'agentMessage', text: '正文'.repeat(65_536) },
      ] }] } }
    },
    'thread/items/list': () => ({ result: { data: [], backwardsCursor: 'after-snapshot' } }),
  })
  const released = Promise.withResolvers()
  const route = createWatchRoute(socketPath, undefined, {
    observe(_threadId, _send, signal) {
      signal.addEventListener('abort', () => released.resolve(), { once: true })
    },
  })
  const response = await route.fetch(new Request('http://localhost/api/codex/watch?threadId=large&questions=1'))
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const first = await reader.read()
  assert.equal(first.done, false)
  assert.ok(!new TextDecoder().decode(first.value).endsWith('\n\n'))
  upstream.terminate()
  await released.promise
  assert.equal((await reader.read()).done, true)
})

test('SSE 大快照分块发送，续读检查点在完整快照之后到达', { timeout: 5000 }, async t => {
  const text = '大型历史正文。'.repeat(110_000)
  const { get } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'large', historyMode: 'paginated' } } }),
    'thread/turns/list': () => ({ result: { data: [{ id: 'turn', status: 'completed',
      items: [{ id: 'reply', type: 'agentMessage', text }] }] } }),
    'thread/items/list': () => ({ result: { data: [], backwardsCursor: 'after-snapshot' } }),
  })
  const reader = (await get('/api/codex/watch?threadId=large')).body.getReader()
  t.after(() => reader.cancel())
  const decoder = new TextDecoder()
  let frame = ''
  let chunks = 0
  while (!frame.endsWith('\n\n')) {
    const { done, value } = await reader.read()
    assert.equal(done, false)
    frame += decoder.decode(value, { stream: true })
    chunks++
  }
  assert.equal(JSON.parse(frame.slice(6)).page.data[0].items[0].text, text)
  assert.ok(chunks > 1)
  assert.match(decoder.decode((await reader.read()).value), /^id: after-snapshot\nevent: history-checkpoint\n/)
})

async function readSseFrame(reader, firstChunk) {
  const decoder = new TextDecoder()
  let frame = firstChunk ? decoder.decode(firstChunk, { stream: true }) : ''
  while (!frame.endsWith('\n\n')) {
    const { done, value } = await reader.read()
    assert.equal(done, false)
    frame += decoder.decode(value, { stream: true })
  }
  return frame
}

test('SSE 历史增量发送当前页后才读取下一页，最后确认终态和检查点', { timeout: 5000 }, async t => {
  const threadId = 'paged-round'
  const turnId = 'round'
  const text = 'x'.repeat(3 * 1024 * 1024)
  let saved = false
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, name: '分批追踪', historyMode: 'paginated' } } }),
    'thread/turns/list': () => ({ result: { data: [{
      id: turnId, status: saved ? 'completed' : 'inProgress', ...(saved && { completedAt: 7 }), items: [],
    }], backwardsCursor: 'after-turn' } }),
    'thread/items/list': ({ turnId: selected, sortDirection, cursor }) => {
      if (!selected) return { result: { data: [],
        ...(sortDirection === 'desc' && { backwardsCursor: saved ? 'after-append' : 'before-append' }),
      } }
      const page = Number(cursor ?? 0)
      return { result: { data: [{ item: { id: `reply-${page}`, type: 'agentMessage', text }, completedAtMs: page + 1 }],
        nextCursor: page < 3 ? String(page + 1) : null } }
    },
  })
  const reader = (await fixture.get(`/api/codex/watch?threadId=${threadId}`)).body.getReader()
  t.after(() => reader.cancel())
  assert.equal(JSON.parse((await readSseFrame(reader)).slice(6)).type, 'snapshot')
  assert.match(await readSseFrame(reader), /^id: before-append\n/)
  saved = true
  const readState = { firstUnread: { type: 'turn', turnId }, revision: 'new' }
  fixture.broadcast({ method: 'thread/readState/changed', params: { threadId, readState } })
  const first = await reader.read()
  assert.equal(first.value.length, 64 * 1024)
  await delay(30)
  const pages = () => fixture.messages.filter(({ method, params }) =>
    method === 'thread/items/list' && params.turnId === turnId).map(({ params }) => params.cursor)
  assert.deepEqual(pages(), [undefined])

  let frame = await readSseFrame(reader, first.value)
  const received = []
  let completedAfter
  while (frame.startsWith('data: ')) {
    const update = JSON.parse(frame.slice(6))
    assert.ok(Buffer.byteLength(frame) <= Buffer.byteLength(text) + 1024)
    assert.equal(update.type, 'change')
    assert.equal(update.turn.id, turnId)
    assert.ok(update.items.length <= 1)
    for (const item of update.items) {
      assert.equal(item.text, text)
      received.push(item.id)
    }
    if (update.turn.status === 'completed') {
      assert.equal(update.turn.completedAt, 7)
      completedAfter = received.length
    } else assert.equal(update.turn.completedAt, undefined)
    frame = await readSseFrame(reader)
  }
  assert.deepEqual(pages(), [undefined, '1', '2', '3'])
  assert.deepEqual(received, ['reply-0', 'reply-1', 'reply-2', 'reply-3'])
  assert.equal(completedAfter, received.length)
  assert.match(frame, /^id: after-append\nevent: history-checkpoint\n/)
  assert.deepEqual(JSON.parse((await readSseFrame(reader)).slice(6)), { type: 'reading-receipt', readState })
})

test('旧版历史增量按 UTF-8 字节限制单帧，保留原生条目', { timeout: 5000 }, async t => {
  const threadId = 'legacy-round'
  const text = '界'.repeat(400_000)
  const items = [0, 1, 2].map(index => ({ id: `reply-${index}`, type: 'agentMessage', text }))
  let saved = false
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, name: '旧版历史', historyMode: 'legacy' } } }),
    'thread/turns/list': () => ({ result: { data: [{ id: 'round', status: 'inProgress', items: saved ? items : [] }] } }),
  })
  const reader = (await fixture.get(`/api/codex/watch?threadId=${threadId}`)).body.getReader()
  t.after(() => reader.cancel())
  assert.equal(JSON.parse((await readSseFrame(reader)).slice(6)).type, 'snapshot')
  saved = true
  const readState = { firstUnread: { type: 'turn', turnId: 'round' }, revision: 'new' }
  fixture.broadcast({ method: 'thread/readState/changed', params: { threadId, readState } })
  for (const item of items) {
    const frame = await readSseFrame(reader)
    assert.ok(Buffer.byteLength(frame) <= 2 * 1024 * 1024)
    const update = JSON.parse(frame.slice(6))
    assert.equal(update.type, 'change')
    assert.deepEqual(update.items, [item])
  }
  assert.deepEqual(JSON.parse((await readSseFrame(reader)).slice(6)), { type: 'reading-receipt', readState })
})

test('只读 SSE 在原生历史变更后推送增量和状态，且不恢复线程', { timeout: 5000 }, async t => {
  const threadId = 'observed'
  const head = { id: 'round', status: 'inProgress', items: [] }
  const goal = { threadId, status: 'active', objective: '核对当前轮次' }
  const old = { id: 'first', type: 'agentMessage', text: '原有', completedAtMs: 1000 }
  const fresh = { id: 'second', type: 'agentMessage', text: '新增', completedAtMs: 2000 }
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status: { type: 'active', activeFlags: [] }, historyMode: 'paginated' } } }),
    'thread/goal/get': () => ({ result: { goal } }),
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
  assert.deepEqual(snapshot.goal, goal)
  const waiting = { type: 'active', activeFlags: ['waitingOnUserInput'] }
  fixture.broadcast({ id: 'request', method: 'item/tool/requestUserInput', params: { threadId } })
  fixture.broadcast({ method: 'thread/status/changed', params: { threadId, status: waiting } })
  const state = await read()
  assert.deepEqual(state.notification.params.status, waiting)
  await writeFile(join(fixture.directory, 'thread_history_1.sqlite-wal'), 'write notification')
  const change = await read()
  assert.equal(change.type, 'change')
  assert.deepEqual(change.items.map(item => item.id), ['second'])
  const allowed = new Set(['initialize', 'initialized', 'thread/read', 'thread/goal/get', 'config/read', 'thread/turns/list', 'thread/items/list'])
  assert.equal(fixture.messages.every(message => allowed.has(message.method)), true)
  assert.equal(fixture.messages[0].params.clientInfo.name, 'codex_app_server_daemon')
  await reader.cancel()
  await fixture.clientClosed
})

test('分页历史 WAL 只唤醒检查点变动的会话，rollout 单独推送变化字段', { timeout: 5000 }, async t => {
  const threads = ['first', 'second', 'third']
  const turn = { id: 'round', status: 'completed', items: [] }
  const late = { type: 'agentMessage', id: 'late', text: '已保存的增量' }
  const event = (type, payload) => JSON.stringify({ type, payload }) + '\n'
  const tokens = total_tokens => event('event_msg', { type: 'token_count',
    info: { last_token_usage: { total_tokens }, model_context_window: 100 } })
  let directory
  let projected = false
  const { get, messages, directory: sqliteHome } = await fakeCodex(t, {
    'thread/read': ({ threadId }) => ({ result: { thread: { id: threadId, name: threadId,
      status: { type: 'idle' }, historyMode: 'paginated', path: join(directory, `${threadId}.jsonl`),
    } } }),
    'thread/turns/list': () => ({ result: { data: [turn], backwardsCursor: 'round' } }),
    'thread/items/list': ({ threadId, cursor }) => ({ result: {
      backwardsCursor: threadId === threads[0] && projected ? 'new-item' : 'initial-item',
      data: cursor === 'initial-item' ? [{ turnId: turn.id, item: late }] : [],
    } }),
  })
  directory = sqliteHome
  using db = openHistoryProjection(directory)
  const checkpoint = db.prepare('INSERT OR REPLACE INTO thread_history_projection_state VALUES (?, ?, ?)')
  for (const id of threads) {
    checkpoint.run(id, 10, 1)
    await writeFile(join(directory, `${id}.jsonl`), event('turn_context', { turn_id: turn.id, cwd: '/work' }) + tokens(20))
  }
  const readers = await Promise.all(threads.map(async id => (await get(`/api/codex/watch?threadId=${id}`)).body.getReader()))
  t.after(() => Promise.all(readers.map(reader => reader.cancel())))
  const read = async reader => new TextDecoder().decode((await reader.read()).value)
  const frame = async reader => JSON.parse((await read(reader)).slice(6))
  for (const reader of readers) {
    assert.equal((await frame(reader)).type, 'snapshot')
    assert.match(await read(reader), /^id: initial-item\n/)
    assert.deepEqual(await frame(reader), { type: 'rollout-facts', contextPressure: { pressureTokens: 20, contextWindow: 100 },
      turnWorkingDirectories: { round: '/work' } })
  }

  let start = messages.length
  for (let ordinal = 1; ordinal <= 4; ordinal++) {
    checkpoint.run('unobserved', 20 * ordinal, ordinal)
    await delay(180)
  }
  assert.equal(messages.length - start, 0, '无关的四次提交引起的额外 RPC')

  projected = true
  checkpoint.run(threads[0], 30, 2)
  assert.deepEqual(await frame(readers[0]), { type: 'change', turn: { id: turn.id, status: turn.status }, items: [late], onlyIfLoaded: true })
  assert.match(await read(readers[0]), /^id: new-item\n/)
  assert.ok(messages.length > start)
  assert.ok(messages.slice(start).every(({ params }) => params.threadId === threads[0]))

  start = messages.length
  await appendFile(join(directory, `${threads[0]}.jsonl`), tokens(30))
  assert.deepEqual(await frame(readers[0]), { type: 'rollout-facts', contextPressure: { pressureTokens: 30, contextWindow: 100 } })
  assert.equal(messages.length - start, 0)

  await appendFile(join(directory, `${threads[0]}.jsonl`), event('event_msg', { type: 'thread_rolled_back', num_turns: 1 }))
  assert.deepEqual(await frame(readers[0]), { type: 'rollout-facts', contextPressure: null, turnWorkingDirectories: { round: null } })
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

test('目录订阅共享未读查询与快照，最后一个订阅关闭后释放监听', { timeout: 5000 }, async t => {
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'selected' }, readState: { firstUnread: null, revision: 'one' } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
  })
  const db = new DatabaseSync(join(fixture.directory, 'state_5.sqlite'))
  t.after(() => db.close())
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE thread_read_receipts (thread_id TEXT PRIMARY KEY, first_unread_turn TEXT);
    INSERT INTO thread_read_receipts VALUES ('other', 'previous-turn');
    CREATE TABLE unrelated (value INTEGER);`)
  let reads = 0
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (sql.includes('SELECT thread_id FROM thread_read_receipts')) reads++
    return prepare.call(this, sql)
  })
  async function read(reader) {
    const { value, done } = await reader.read()
    if (!done) return JSON.parse(new TextDecoder().decode(value).slice(6))
  }
  async function subscribe(ids) {
    const reader = (await fixture.get('/api/codex/watch?scope=catalog')).body.getReader()
    t.after(() => reader.cancel())
    assert.deepEqual(await read(reader), { type: 'catalog-ready' })
    assert.deepEqual(await read(reader), { type: 'unread', replace: true, added: ids, removed: [] })
    return reader
  }
  const readers = []
  for (let index = 0; index < 3; index++) readers.push(await subscribe(['other']))
  const initialReads = reads
  const unrelated = db.prepare('INSERT INTO unrelated VALUES (?)')
  let updates = 0
  const deltas = readers.map(async reader => {
    const frame = await read(reader)
    updates++
    return frame
  })
  // 即使每次都超过合并窗口，三个订阅也只需一次共享查询。
  for (let index = 0; index < 4; index++) {
    unrelated.run(index)
    await delay(230)
  }
  assert.equal(reads - initialReads, 4, '无关写入引起的未读查询次数')
  assert.equal(initialReads, 1)
  assert.equal(updates, 0)
  db.exec(`UPDATE thread_read_receipts SET first_unread_turn = NULL WHERE thread_id = 'other';
    INSERT INTO thread_read_receipts VALUES ('new', '');`)
  for (const delta of await Promise.all(deltas)) {
    assert.deepEqual(delta, { type: 'unread', replace: false, added: ['new'], removed: ['other'] })
  }
  assert.equal(reads, initialReads + 5)
  assert.deepEqual(fixture.messages.map(message => message.method).sort(),
    readers.flatMap(() => ['initialize', 'initialized', 'config/read']).sort())
  await readers[0].cancel()
  const remaining = readers.slice(1)
  db.exec("DELETE FROM thread_read_receipts WHERE thread_id = 'new'")
  for (const delta of await Promise.all(remaining.map(read))) {
    assert.deepEqual(delta, { type: 'unread', replace: false, added: [], removed: ['new'] })
  }
  assert.equal(reads, initialReads + 6)
  await Promise.all(remaining.map(reader => reader.cancel()))
  db.exec("INSERT INTO thread_read_receipts VALUES ('offline', 'turn')")
  await delay(230)
  assert.equal(reads, initialReads + 6)
  await subscribe(['offline'])
  assert.equal(reads, initialReads + 7)
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

test('回退在同一 SSE 连接替换快照并跟随新的 rollout 和投影', { timeout: 5000 }, async t => {
  const threadId = '019af000-0000-7000-8000-000000000001'
  const replacementId = '019af000-0000-7000-8000-000000000002'
  const kept = { id: 'kept', status: 'completed', items: [] }
  const late = { type: 'agentMessage', id: 'late', text: '回退后写入' }
  let turns = [{ ...kept, id: 'removed' }, kept]
  let itemCursor = 'before-revert'
  let path
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, historyMode: 'paginated', path } } }),
    'config/read': () => ({ result: { config: {} } }),
    'thread/turns/list': () => ({ result: { data: turns, nextCursor: turns[0].id } }),
    'thread/items/list': ({ cursor }) => ({ result: { backwardsCursor: itemCursor,
      data: cursor === 'after-revert' ? [{ item: late, turnId: kept.id }] : [] } }),
  })
  using db = openHistoryProjection(fixture.directory)
  const checkpoint = db.prepare('INSERT OR REPLACE INTO thread_history_projection_state VALUES (?, ?, ?)')
  checkpoint.run(threadId, 10, 1)
  const prefix = join(fixture.directory, `rollout-2026-11-23T00-00-00-${threadId}`)
  const context = (turn_id, cwd) => JSON.stringify({ type: 'turn_context', payload: { turn_id, cwd } }) + '\n'
  path = `${prefix}.jsonl`
  await writeFile(path, context('removed', '/removed'))
  const response = await fixture.get(`/api/codex/watch?threadId=${threadId}`)
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const readText = async () => new TextDecoder().decode((await reader.read()).value)
  const read = async () => JSON.parse((await readText()).slice(6))
  assert.equal((await read()).page.nextCursor, 'removed')
  assert.match(await readText(), /^id: before-revert\n/)
  assert.deepEqual(await read(), { type: 'rollout-facts', turnWorkingDirectories: { removed: '/removed' } })

  turns = [kept]
  path = `${prefix}_${replacementId}.jsonl`
  itemCursor = 'after-revert'
  checkpoint.run(replacementId, 10, 1)
  await writeFile(path, '')
  fixture.broadcast({ method: 'thread/reverted', params: { threadId } })
  const snapshot = await read()
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.replace, true)
  assert.deepEqual(snapshot.page, { data: [kept], nextCursor: 'kept' })
  assert.match(await readText(), /^id: after-revert\n/)
  assert.deepEqual(await read(), { type: 'rollout-facts', turnWorkingDirectories: { removed: null } })

  await appendFile(path, context('kept', '/new'))
  assert.deepEqual(await read(), { type: 'rollout-facts', turnWorkingDirectories: { kept: '/new' } })
  itemCursor = 'next-item'
  checkpoint.run(replacementId, 20, 2)
  assert.deepEqual((await read()).items, [late])
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

test('队列 WAL 只刷新修订号变动的会话，仍直接处理目标通知', { timeout: 5000 }, async t => {
  const ids = ['019afabc-0000-7000-8000-000000000001', 'second', 'third']
  const queued = { id: 'native-id', input: [{ type: 'text', text: '原生排队' }] }
  let entries = []
  const fixture = await fakeCodex(t, {
    'thread/read': ({ threadId }) => ({ result: { thread: { id: threadId.toLowerCase(), status: { type: 'notLoaded' } } } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'thread/queue/list': ({ threadId }) => ({ result: { data: threadId.toLowerCase() === ids[0] ? entries : [], nextCursor: null } }),
  })
  using db = new DatabaseSync(join(fixture.directory, 'queue_1.sqlite'))
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE queued_thread_revisions (revision INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL UNIQUE);`)
  const write = db.prepare('INSERT OR REPLACE INTO queued_thread_revisions (thread_id) VALUES (?)')
  const readers = await Promise.all(ids.map(async id =>
    (await fixture.get(`/api/codex/watch?threadId=${id.toUpperCase()}&queue=1`)).body.getReader()))
  t.after(() => Promise.all(readers.map(reader => reader.cancel())))
  const read = async reader => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  const requests = () => fixture.messages.filter(({ method }) => method === 'thread/queue/list')
  for (const reader of readers) {
    assert.equal((await read(reader)).type, 'snapshot')
    assert.deepEqual(await read(reader), { type: 'queue', submissions: [] })
  }

  const start = requests().length
  for (let index = 0; index < 4; index++) {
    write.run('unobserved')
    await delay(150)
  }
  assert.equal(requests().length - start, 0, '无关队列的四次提交引起的额外 RPC')

  entries = [queued]
  write.run(ids[0])
  assert.deepEqual(await read(readers[0]), { type: 'queue', submissions: [queued] })
  entries = []
  fixture.broadcast({ method: 'thread/queue/changed', params: { threadId: ids[0] } })
  assert.deepEqual(await read(readers[0]), { type: 'queue', submissions: [] })
  assert.deepEqual(requests().slice(start).map(({ params }) => params.threadId), [ids[0], ids[0]])
})

test('归档队列按原生顺序只读显示，并跟随队列清空', { timeout: 4000 }, async t => {
  const threadId = 'archived-with-queue'
  const status = { type: 'notLoaded' }
  const fixture = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: threadId, status } } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => ({ error: { code: -32600,
      message: `session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`,
    } }),
  })
  using db = new DatabaseSync(join(fixture.directory, 'queue_1.sqlite'))
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER)`)
  const insert = db.prepare('INSERT INTO queued_items VALUES (?, ?, ?, ?)')
  const message = { type: 'text', text: '首条消息', text_elements: [] }
  const url = 'data:image/png;base64,AA=='
  const payload = (client_id, content) => JSON.stringify({ UserInput: { client_id, content } })
  insert.run('last', threadId, payload('client-last', [{ type: 'text', text: '末条消息' }]), 1)
  insert.run('first', threadId, payload('client-first', [message, { type: 'image', image_url: url }]), 0)
  insert.run('other', 'other-thread', payload('client-other', [message]), 0)

  const result = await fixture.get(`/api/codex/watch?threadId=${threadId}&queue=1`, { signal: t.signal })
  const reader = result.body.getReader()
  t.after(() => reader.cancel())
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.deepEqual((await read()).status, status)
  assert.deepEqual(await read(), { type: 'queue', submissions: [
    { id: 'first', clientUserMessageId: 'client-first', input: [message, { type: 'image', url }] },
    { id: 'last', clientUserMessageId: 'client-last', input: [{ type: 'text', text: '末条消息' }] },
  ] })
  db.prepare('DELETE FROM queued_items WHERE thread_id = ?').run(threadId)
  assert.deepEqual(await read(), { type: 'queue', submissions: [] })
  assert.equal(fixture.messages.some(({ method }) => ['thread/unarchive', 'thread/resume', 'thread/queue/start'].includes(method)), false)
  await reader.cancel()
})

test('首次原生队列读取失败时不向网页推送空队列', async t => {
  const queueRead = Promise.withResolvers()
  const { get } = await fakeCodex(t, {
    'thread/read': () => ({ result: { thread: { id: 'thread', status: { type: 'notLoaded' } } } }),
    'thread/turns/list': () => ({ result: { data: [] } }),
    'thread/queue/list': () => {
      queueRead.resolve()
      return { error: { code: -32600, message: '暂时无法读取原生队列' } }
    },
  })
  const watch = await get('/api/codex/watch?threadId=thread&queue=1', { signal: AbortSignal.timeout(2_000) })
  const reader = watch.body.getReader()
  t.after(() => reader.cancel())
  assert.equal(JSON.parse(Buffer.from((await reader.read()).value).toString().slice(6)).type, 'snapshot')
  await queueRead.promise
  assert.equal(await Promise.race([reader.read().then(() => true), delay(80, false)]), false)
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

test('子代理开始执行后，侧栏收到带父子关系的线程摘要', { timeout: 5000 }, async t => {
  const active = { type: 'active', activeFlags: [] }
  const child = {
    id: 'child', parentThreadId: 'running-parent', status: active,
    source: { subAgent: { thread_spawn: { parent_thread_id: 'running-parent', agent_path: '/root/check' } } },
  }
  let saved = false
  const fixture = await fakeCodex(t, {
    'thread/read': ({ threadId }) => saved && threadId === child.id
      ? { result: { thread: child } }
      : { error: { code: -32600, message: `thread not found: ${threadId}` } },
  })
  const response = await fixture.get('/api/codex/watch?scope=catalog')
  const reader = response.body.getReader()
  t.after(() => reader.cancel())
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
  assert.deepEqual(await read(), { type: 'catalog-ready' })

  const statusChanged = status => ({ method: 'thread/status/changed', params: { threadId: child.id, status } })
  const idle = statusChanged({ type: 'idle' })
  // App Server 内部创建的子线程没有 thread/started，首次状态可能早于摘要可读。
  fixture.broadcast(idle)
  assert.deepEqual(await read(), { type: 'notification', notification: idle })

  saved = true
  const started = statusChanged(active)
  fixture.broadcast(started)
  assert.deepEqual(await read(), { type: 'notification', notification: started, thread: child, workspacePaths: {} })
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
