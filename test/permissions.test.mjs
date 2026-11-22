import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

test('网页默认预设只在新建时生效，重新读取仍可用，并拒绝目标目录不允许的预设', async t => {
  const { createPermissionActions } = await import('../src/host/permissions.mjs')
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'perm-'))
  const socket = join(directory, 'api.sock')
  const http = createServer()
  const ws = new WebSocketServer({ server: http })
  ws.on('connection', client => {
    client.on('message', raw => {
      const { id, method } = JSON.parse(raw)
      if (id === undefined) return
      const result = method === 'initialize' ? {} : { data: [{ id: 'custom-team', allowed: true }] }
      client.send(JSON.stringify({ id, result }))
    })
  })
  http.listen(socket)
  await once(http, 'listening')
  t.after(async () => {
    for (const client of ws.clients) client.terminate()
    ws.close()
    const closed = once(http, 'close')
    http.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  const preference = join(directory, 'default.json')
  const load = () => createPermissionActions(socket, undefined, preference)
  const permissions = load()
  const request = new Request(`http://localhost${permissions.actionRoute.path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'default', profileId: 'custom-team' }),
  })
  assert.equal((await permissions.actionRoute.fetch(request)).status, 200)
  const calls = []
  const native = async (method, params) => {
    calls.push([method, params])
    return { data: [{ id: 'custom-team', allowed: params.cwd === '/team' }] }
  }
  assert.deepEqual(await load().startOptions(native, '/team'), { permissions: 'custom-team' })
  await assert.rejects(load().startOptions(native, '/other'), /当前工作目录/)
  assert.deepEqual(calls, [
    ['permissionProfile/list', { cwd: '/team' }],
    ['permissionProfile/list', { cwd: '/other' }],
  ])
})

test('切换权限只把 Codex 原生允许的预设交给当前会话', async () => {
  const { updateThreadPermission } = await import('../src/host/permissions.mjs')
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === 'thread/read') return { thread: { id: 'thread', cwd: '/team', status: { type: 'idle' } } }
    if (method === 'permissionProfile/list') return { data: [
      { id: ':read-only', allowed: true }, { id: ':danger-full-access', allowed: false },
    ] }
    if (method === 'thread/resume') return { activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request' }
    if (method === 'thread/settings/update') return {}
    throw new Error(`unexpected ${method}`)
  }
  const confirmed = { profileId: ':read-only', approvalPolicy: 'on-request', sandbox: 'readOnly', source: 'runtime' }
  assert.deepEqual(await updateThreadPermission(request, 'thread', ':read-only', async () => confirmed), confirmed)
  assert.deepEqual(calls.at(-1), ['thread/settings/update', { threadId: 'thread', permissions: ':read-only' }])
  calls.length = 0
  await assert.rejects(updateThreadPermission(request, 'thread', ':danger-full-access', async () => confirmed), /当前工作目录/)
  assert.equal(calls.some(([method]) => method === 'thread/settings/update' || method === 'thread/resume'), false)
})

test('历史权限优先采用该线程的设置检查点，运行中的旧轮次不能覆盖它', async t => {
  const { writeFile } = await import('node:fs/promises')
  const { createRolloutFacts } = await import('../src/host/rollout-facts.mjs')
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'perm-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'history.jsonl')
  const policy = id => ({ active_permission_profile: { id }, permission_profile: { type: 'managed' },
    approval_policy: 'on-request', approvals_reviewer: 'auto_review' })
  const settings = (owner, id) => ({ type: 'event_msg', payload: {
    type: 'thread_settings_applied', thread_id: owner, thread_settings: policy(id),
  } })
  const rows = [settings('this-thread', ':workspace'), settings('other-thread', ':danger-full-access'),
    { type: 'turn_context', payload: policy(':read-only') }]
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const facts = createRolloutFacts(path, new AbortController().signal, 'this-thread')
  assert.deepEqual((await facts.read()).permission, { profileId: ':workspace', sandbox: 'managed', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', source: 'saved' })
})

test('旧式工作区写入沿用规则相同的 Codex 原生沙箱名称', async t => {
  const { appendFile, writeFile } = await import('node:fs/promises')
  const { createRolloutFacts } = await import('../src/host/rollout-facts.mjs')
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'perm-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'history.jsonl')
  const cwd = '/repo'
  const profile = {
    type: 'managed', network: 'restricted', file_system: { type: 'restricted', entries: [
      { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
      { path: { type: 'path', path: cwd }, access: 'write' },
    ] },
  }
  const settings = (permissionProfile, workdir = cwd) => ({ type: 'event_msg', payload: {
    type: 'thread_settings_applied', thread_id: 'this-thread', thread_settings: {
      cwd: workdir, permission_profile: permissionProfile, approval_policy: 'on-request', approvals_reviewer: 'user',
    },
  } })
  const turn = { type: 'turn_context', payload: {
    cwd, permission_profile: profile, sandbox_policy: { type: 'workspace-write' }, approval_policy: 'never',
  } }
  const line = row => `${JSON.stringify(row)}\n`
  await writeFile(path, line(settings(profile)) + line(turn))
  const facts = createRolloutFacts(path, new AbortController().signal, 'this-thread')
  assert.deepEqual((await facts.read()).permission, {
    profileId: null, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', source: 'saved',
  })

  await appendFile(path, line(settings({ ...profile, network: 'enabled' })))
  assert.equal((await facts.read()).permission.sandbox, 'managed')

  await appendFile(path, line(settings(profile, '/other')))
  assert.equal((await facts.read()).permission.sandbox, 'managed')
})

test('首条消息前可设置权限，同时把原生尚未确认的选择单独标记', async () => {
  const { updateThreadPermission } = await import('../src/host/permissions.mjs')
  const { CodexRpcError } = await import('../src/host/app-server.mjs')
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === 'thread/read') return { thread: { id: 'draft', cwd: '/team', status: { type: 'idle' }, historyMode: 'paginated', preview: '' } }
    if (method === 'permissionProfile/list') return { data: [{ id: ':read-only', allowed: true }] }
    if (method === 'thread/turns/list') throw new CodexRpcError({ code: -32600, message: 'thread/turns/list is unavailable before first user message' })
    if (method === 'thread/settings/update') return {}
    throw new Error(`unexpected ${method}`)
  }
  const pending = await updateThreadPermission(request, 'draft', ':read-only', () => assert.fail('未接入正在运行的连接'))
  assert.deepEqual(pending, { profileId: ':read-only', source: 'requested' })
  assert.deepEqual(calls.at(-1), ['thread/settings/update', { threadId: 'draft', permissions: ':read-only' }])
})

test('网页新建草稿在首条消息前收到 Codex 实际应用权限的确认', async t => {
  const { createHistoryRoutes } = await import('../src/host/history.mjs')
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'perm-draft-'))
  const socket = join(directory, 'api.sock')
  const server = createServer()
  const ws = new WebSocketServer({ server })
  const owner = new AbortController()
  const thread = { id: 'draft', cwd: directory, status: { type: 'idle' }, historyMode: 'paginated', preview: '' }
  const initial = { activePermissionProfile: { id: ':read-only' }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } }
  const fullAccess = { activePermissionProfile: { id: ':danger-full-access' }, approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' } }
  const expected = { profileId: ':danger-full-access', approvalPolicy: 'on-request', sandbox: 'dangerFullAccess', source: 'runtime' }
  const threads = new Map([[thread.id, thread]])
  let creator
  const applied = Promise.withResolvers()
  const update = Promise.withResolvers()
  ws.on('connection', client => client.on('message', raw => {
    const { id, method, params } = JSON.parse(raw)
    if (id === undefined) return
    const reply = result => client.send(JSON.stringify({ id, result }))
    const notify = (method, params) => creator?.send(JSON.stringify({ method, params }))
    if (method === 'initialize') return reply({})
    if (method === 'thread/start') {
      if (params.permissions === ':danger-full-access') {
        const draft = { ...thread, id: `draft-${threads.size}` }
        threads.set(draft.id, draft)
        return reply({ thread: draft, ...fullAccess })
      }
      creator = client
      return reply({ thread, ...initial })
    }
    if (method === 'thread/read') return reply({ thread: threads.get(params.threadId) })
    if (method === 'thread/queue/list') return reply({ data: [] })
    if (method === 'permissionProfile/list') return reply({ data: [{ id: ':danger-full-access', allowed: true }] })
    if (method === 'thread/turns/list') {
      return client.send(JSON.stringify({ id, error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }))
    }
    if (method === 'thread/settings/update') {
      reply({})
      update.resolve(params)
      void applied.promise.then(() => notify('thread/settings/updated', { threadId: thread.id, threadSettings: fullAccess }))
      return
    }
    assert.fail(`unexpected ${method}`)
  }))
  server.listen(socket)
  await once(server, 'listening')
  t.after(async () => {
    owner.abort()
    for (const client of ws.clients) client.terminate()
    ws.close()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })

  const routes = createHistoryRoutes(socket, owner.signal)
  function post(path, fields, signal, source = routes) {
    const route = source.find(route => route.path === `/api/codex/${path}`)
    return route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields), signal,
    }))
  }

  const request = new AbortController()
  const created = await post('conversation-action', { action: 'create', cwd: directory }, request.signal)
  assert.equal(created.status, 200)
  assert.equal((await created.json()).permission.profileId, ':read-only')
  request.abort()
  const reopened = await post('conversation-action', { action: 'create', cwd: directory, reuseThreadId: thread.id })
  const reopenedDraft = await reopened.json()
  assert.equal(reopenedDraft.thread.id, thread.id)
  assert.equal(reopenedDraft.permission.profileId, ':read-only')

  const otherHost = createHistoryRoutes(socket, owner.signal)
  for (const source of [routes, otherHost]) {
    const saved = await post('permission-action', { action: 'default', profileId: ':danger-full-access' }, undefined, source)
    assert.equal(saved.status, 200)
    const next = await post('conversation-action', { action: 'create', cwd: directory, reuseThreadId: thread.id }, undefined, source)
    assert.equal(next.status, 200)
    const draft = await next.json()
    assert.notEqual(draft.thread.id, thread.id)
    assert.deepEqual(draft.permission, expected)
    const same = await post('conversation-action', { action: 'create', cwd: directory, reuseThreadId: draft.thread.id }, undefined, source)
    const sameDraft = await same.json()
    assert.equal(sameDraft.thread.id, draft.thread.id)
    assert.deepEqual(sameDraft.permission, expected)
  }
  const selection = post('permission-action', { action: 'select', threadId: thread.id, profileId: ':danger-full-access' })
  assert.deepEqual(await update.promise, { threadId: thread.id, permissions: ':danger-full-access' })
  applied.resolve()
  const response = await selection
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).permission, expected)
  const catalog = routes.find(route => route.path === '/api/codex/permissions')
  const loaded = await catalog.fetch(new Request(`http://localhost${catalog.path}?threadId=${thread.id}`))
  assert.deepEqual((await loaded.json()).permission, expected)
  const released = once(creator, 'close', { signal: AbortSignal.timeout(1_000) })
  creator.send(JSON.stringify({ method: 'turn/started', params: { threadId: thread.id, turn: { id: 'first-turn' } } }))
  await released
})
