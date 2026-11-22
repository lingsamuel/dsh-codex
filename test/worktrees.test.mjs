import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { createConversationActionRoute } from '../src/host/conversation-actions.mjs'
import { createWorktreeRoutes } from '../src/host/worktree-actions.mjs'

const post = (route, fields) => route.fetch(new Request(`http://local${route.path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
}))
const lookup = (route, cwd) => route.fetch(new Request(`http://local${route.path}?${new URLSearchParams({ cwd })}`))

async function fixture(t, handlers = {}) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'wt-'))
  const repo = join(directory, 'project with spaces')
  const existing = join(directory, 'existing checkout')
  await mkdir(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Worktree fixture')
  git('config', 'user.email', 'fixture@example.test')
  await mkdir(join(repo, 'component'))
  await writeFile(join(repo, 'component', 'base.txt'), 'project subdirectory\n')
  await writeFile(join(repo, 'tracked.txt'), 'selected base\n')
  git('add', 'tracked.txt', 'component/base.txt')
  git('commit', '-m', 'Base')
  git('branch', 'alternate')
  await writeFile(join(repo, 'tracked.txt'), 'main commit\n')
  git('commit', '-am', 'Main')
  git('worktree', 'add', '--detach', existing, 'alternate')
  await writeFile(join(repo, 'tracked.txt'), 'local edits\n')
  await writeFile(join(repo, 'private.txt'), 'local private data\n')
  await writeFile(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch .worktree-hook-ran\n', { mode: 0o755 })
  const http = createServer()
  const sockets = new WebSocketServer({ server: http })
  const calls = []
  sockets.on('connection', socket => socket.on('message', async message => {
    const { method, params, id } = JSON.parse(message)
    if (id === undefined) return
    calls.push({ method, params })
    const result = method === 'initialize' ? {} : await handlers[method]?.(params)
    if (result === 'disconnect') return socket.terminate()
    const error = result?.error ?? (!result && { code: -32601, message: method })
    socket.send(JSON.stringify(error ? { id, error } : { id, result }))
  }))
  const socket = join(directory, 'c.sock')
  http.listen(socket)
  await once(http, 'listening')
  t.after(async () => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    const closed = once(http, 'close')
    http.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  const [list, change] = createWorktreeRoutes(socket)
  return { repo, existing, git, list, change, conversation: createConversationActionRoute(socket), calls }
}

const idle = { type: 'idle' }

test('在首次提交时以所选 Git 分支启动原生工作树会话；失败重试与并发提交复用同一会话', async t => {
  const threads = new Map()
  let editedFile, nativeCwd, queueAttempts = 0
  const { repo, existing, git, list, conversation, calls } = await fixture(t, {
    'thread/start': async ({ cwd, projectId }) => {
      assert.equal(projectId, 'keep-project')
      nativeCwd = cwd
      editedFile = await readFile(join(cwd, 'tracked.txt'), 'utf8')
      const thread = { id: 'worktree', cwd, projectId, historyMode: 'paginated', status: idle }
      threads.set(thread.id, thread)
      return { thread }
    },
    'thread/read': ({ threadId }) => ({ thread: threads.get(threadId) }),
    'thread/queue/list': () => ({ data: [] }),
    'thread/turns/list': () => ({ error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }),
    'thread/queue/add': () => ++queueAttempts === 1 ? { error: { code: -32602, message: 'fixture transient failure' } }
      : { queuedSubmission: { id: 'queued' } },
  })
  threads.set('draft', { id: 'draft', cwd: repo, projectId: 'keep-project', historyMode: 'paginated', status: idle })
  const before = await (await lookup(list, repo)).json()
  assert.equal(before.local.path, repo)
  assert.deepEqual(before.worktrees.map(entry => entry.path), [existing])
  assert.deepEqual(before.branches.map(entry => entry.ref), ['refs/heads/alternate', 'refs/heads/main'])
  assert.equal(calls.length, 0)

  const id = randomUUID()
  const fields = { action: 'prompt', mode: 'queue', input: [{ type: 'text', text: 'Start in Git' }],
    threadId: 'draft', clientUserMessageId: id, worktree: { kind: 'new', id, baseRef: 'refs/heads/alternate' } }
  assert.equal((await post(conversation, { ...fields, input: [] })).status, 400)
  assert.equal((await (await lookup(list, repo)).json()).worktrees.length, 1)
  assert.equal((await post(conversation, fields)).status, 400)
  const edited = { ...fields, input: [{ type: 'text', text: 'Revised after definite failure' }] }
  const results = await Promise.all([post(conversation, edited), post(conversation, edited)])
  for (const response of results) {
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(result.thread.cwd, nativeCwd)
    assert.equal(result.thread.id, 'worktree')
  }
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1)
  const writes = calls.filter(call => call.method === 'thread/queue/add')
  assert.equal(writes.length, 2)
  assert.equal(writes.at(-1).params.input[0].text, 'Revised after definite failure')
  assert.equal(editedFile, 'selected base\n')
  assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'local edits\n')
  assert.equal(await readFile(join(repo, 'private.txt'), 'utf8'), 'local private data\n')
  assert.equal(git('branch', '--show-current'), 'main')
  await assert.rejects(readFile(join(nativeCwd, '.worktree-hook-ran')), { code: 'ENOENT' })
  assert.equal((await (await lookup(list, repo)).json()).worktrees.length, 2)
})

test('用原生设置切换会话目录；活动轮次、待发消息、后台进程或过期目录会阻止切换', async t => {
  let thread, activeQueue = [], terminals = []
  const { repo, existing, change, calls } = await fixture(t, {
    'thread/read': () => ({ thread }),
    'thread/queue/list': () => ({ data: activeQueue }),
    'thread/backgroundTerminals/list': () => ({ data: terminals }),
    'thread/settings/update': ({ cwd }) => { thread = { ...thread, cwd }; return {} },
  })
  thread = { id: 'same-session', projectId: 'same-project', cwd: repo, status: { type: 'active' } }
  const switchTo = (cwd, expectedCwd) => post(change, { threadId: thread.id, cwd, expectedCwd })
  assert.equal((await (await switchTo(existing, repo)).json()).reason, 'worktree-active')
  thread.status = idle
  activeQueue = [{ id: 'queued' }]
  assert.equal((await (await switchTo(existing, repo)).json()).reason, 'worktree-queue')
  activeQueue = []
  terminals = [{ processId: 'running' }]
  assert.equal((await (await switchTo(existing, repo)).json()).reason, 'worktree-background')
  terminals = []
  assert.equal((await (await switchTo(existing, existing)).json()).reason, 'worktree-cwd-changed')
  assert.equal(calls.filter(call => call.method === 'thread/settings/update').length, 0)
  for (const [source, destination] of [[repo, existing], [existing, repo]]) {
    const response = await switchTo(destination, source)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.deepEqual((await response.json()).thread, { ...thread, cwd: destination })
  }
  assert.deepEqual(calls.filter(call => call.method === 'thread/settings/update').map(call => call.params), [
    { threadId: 'same-session', cwd: existing }, { threadId: 'same-session', cwd: repo },
  ])
})


test('子目录项目切换时沿用各工作树中相同的项目路径', async t => {
  let thread
  const { repo, existing, list, change } = await fixture(t, {
    'thread/read': () => ({ thread }),
    'thread/queue/list': () => ({ data: [] }),
    'thread/backgroundTerminals/list': () => ({ data: [] }),
    'thread/settings/update': ({ cwd }) => { thread = { ...thread, cwd }; return {} },
  })
  const local = join(repo, 'component')
  const other = join(existing, 'component')
  thread = { id: 'nested', cwd: local, status: idle }
  for (const [source, target] of [[local, other], [other, local]]) {
    const choices = await (await lookup(list, source)).json()
    assert.equal(choices.local.path, local)
    assert.equal(choices.worktrees[0].path, other)
    const response = await post(change, { threadId: thread.id, cwd: target, expectedCwd: source })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal((await response.json()).thread.cwd, target)
  }
})


test('工作树发送回执丢失后从原生队列确认，不重复加入消息', async t => {
  const threads = new Map()
  let queued
  const { repo, existing, conversation, calls } = await fixture(t, {
    'thread/read': ({ threadId }) => ({ thread: threads.get(threadId) }),
    'thread/start': ({ cwd }) => {
      const thread = { id: 'existing-checkout-thread', cwd, historyMode: 'paginated', status: idle }
      threads.set(thread.id, thread)
      return { thread }
    },
    'thread/turns/list': () => ({ error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }),
    'thread/queue/list': ({ threadId }) => ({ data: queued?.threadId === threadId ? [queued] : [] }),
    'thread/queue/add': params => {
      queued = { ...params, id: 'first-message' }
      return 'disconnect'
    },
    'thread/queue/start': () => ({ turn: null }),
  })
  threads.set('draft', { id: 'draft', cwd: repo, projectId: 'project', historyMode: 'paginated', status: idle })
  const id = randomUUID()
  const fields = { action: 'prompt', mode: 'queue', input: [{ type: 'text', text: 'One message' }],
    threadId: 'draft', clientUserMessageId: id, worktree: { kind: 'existing', path: existing, id } }
  const dropped = await post(conversation, fields)
  assert.equal(dropped.status, 503)
  assert.equal((await dropped.json()).worktreeRecovery.thread.cwd, existing)
  const editedText = { ...fields, input: [{ type: 'text', text: 'Edited message' }] }
  const changedBeforeConfirmation = await post(conversation, editedText)
  assert.equal(changedBeforeConfirmation.status, 409)
  assert.equal((await changedBeforeConfirmation.json()).reason, 'worktree-input-changed')
  const retry = await post(conversation, fields)
  assert.equal(retry.status, 200, JSON.stringify(await retry.clone().json()))
  assert.equal((await retry.json()).thread.cwd, existing)
  const editedImage = { ...fields, input: [...fields.input, { type: 'image', url: 'data:image/png;base64,AAAA' }] }
  const changedAfterConfirmation = await post(conversation, editedImage)
  assert.equal(changedAfterConfirmation.status, 409)
  const conflict = await changedAfterConfirmation.json()
  assert.equal(conflict.reason, 'worktree-input-changed')
  assert.equal(conflict.worktreeRecovery.thread.id, 'existing-checkout-thread')
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1)
})


test('投递结果始终无法确认时保留可打开的原生会话，重试不再次入队', async t => {
  const threads = new Map()
  const { repo, existing, conversation, calls } = await fixture(t, {
    'thread/read': ({ threadId }) => ({ thread: threads.get(threadId) }),
    'thread/start': ({ cwd }) => {
      const thread = { id: 'unconfirmed-native', cwd, historyMode: 'paginated', status: idle }
      threads.set(thread.id, thread)
      return { thread }
    },
    'thread/turns/list': () => ({ error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }),
    'thread/queue/list': () => ({ data: [] }),
    'thread/queue/add': () => 'disconnect',
  })
  threads.set('draft', { id: 'draft', cwd: repo, projectId: 'project', historyMode: 'paginated', status: idle })
  const id = randomUUID()
  const fields = { action: 'prompt', mode: 'queue', input: [{ type: 'text', text: 'One message' }],
    threadId: 'draft', clientUserMessageId: id, worktree: { kind: 'existing', path: existing, id } }
  assert.equal((await post(conversation, fields)).status, 503)
  const retry = await post(conversation, fields)
  assert.equal(retry.status, 409)
  const result = await retry.json()
  assert.equal(result.reason, 'worktree-delivery-unconfirmed')
  assert.equal(result.worktreeRecovery.thread.id, 'unconfirmed-native')
  assert.equal(result.worktreeRecovery.thread.cwd, existing)
  assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, 1)
})
