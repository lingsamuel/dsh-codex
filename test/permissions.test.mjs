import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

async function permissionServer(t) {
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'perm-'))
  const socket = join(directory, 'api.sock')
  const server = createServer()
  const ws = new WebSocketServer({ server })
  server.listen(socket)
  await once(server, 'listening')
  t.after(async () => {
    for (const client of ws.clients) client.terminate()
    ws.close()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, socket, ws }
}

test('网页默认预设只在新建时生效，重新读取仍可用，并拒绝目标目录不允许的预设', async t => {
  const { createPermissionActions } = await import('../src/host/permissions.mjs')
  const { directory, socket, ws } = await permissionServer(t)
  ws.on('connection', client => {
    client.on('message', raw => {
      const { id, method } = JSON.parse(raw)
      if (id === undefined) return
      const result = method === 'initialize' ? {} : { data: [{ id: 'custom-team', allowed: true }] }
      client.send(JSON.stringify({ id, result }))
    })
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

test('未创建原生会话时按草稿工作目录读取允许的权限预设', async t => {
  const { createPermissionActions } = await import('../src/host/permissions.mjs')
  const { directory, socket, ws } = await permissionServer(t)
  const calls = []
  ws.on('connection', client => client.on('message', raw => {
    const { id, method, params } = JSON.parse(raw)
    if (id === undefined) return
    if (method !== 'initialize') calls.push([method, params])
    const result = method === 'config/read'
      ? { config: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' } }
      : { data: [{ id: 'project-permission', allowed: !params?.cwd || params.cwd === directory }] }
    client.send(JSON.stringify({ id, result: method === 'initialize' ? {} : result }))
  }))
  const permissions = createPermissionActions(socket)
  const { catalogRoute, actionRoute } = permissions
  const get = cwd => catalogRoute.fetch(new Request(`http://local${catalogRoute.path}?${new URLSearchParams({ cwd })}`))
  const response = await get(directory)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { profiles: [{ id: 'project-permission' }], defaultProfile: null,
    permission: { profileId: null, sandbox: 'workspace-write', approvalPolicy: 'on-request', source: 'configured' } })
  assert.equal((await get('relative/path')).status, 400)
  const preset = await actionRoute.fetch(new Request(`http://local${actionRoute.path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'default', profileId: 'project-permission' }),
  }))
  assert.equal(preset.status, 200)
  const selected = await get(directory)
  assert.deepEqual((await selected.json()).permission, { profileId: 'project-permission', source: 'configured' })
  assert.deepEqual(calls, [
    ['permissionProfile/list', { cwd: directory }],
    ['config/read', { cwd: directory, includeLayers: false }],
    ['permissionProfile/list', {}],
    ['permissionProfile/list', { cwd: directory }],
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

test('首次发送在工作目录应用默认预设，显式选择优先并等待原生确认', async t => {
  const { createHistoryRoutes } = await import('../src/host/history.mjs')
  const { directory, socket, ws } = await permissionServer(t)
  const owner = new AbortController()
  t.after(() => owner.abort())
  const readOnly = { activePermissionProfile: { id: ':read-only' }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } }
  const workspace = { activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } }
  const expected = { profileId: ':workspace', approvalPolicy: 'on-request', sandbox: 'workspaceWrite', source: 'runtime' }
  const threads = new Map()
  const starters = []
  const enqueued = []
  const profiles = [{ id: ':read-only', allowed: true }, { id: ':workspace', allowed: true }]
  const update = Promise.withResolvers()
  let confirm
  ws.on('connection', client => client.on('message', raw => {
    const { id, method, params } = JSON.parse(raw)
    if (id === undefined) return
    const reply = result => client.send(JSON.stringify({ id, result }))
    if (method === 'initialize') return reply({})
    if (method === 'permissionProfile/list') return reply({ data: profiles })
    if (method === 'thread/start') {
      const thread = { id: `thread-${threads.size + 1}`, cwd: params.cwd, status: { type: 'idle' } }
      threads.set(thread.id, { thread, client })
      starters.push(params)
      return reply({ thread, ...readOnly })
    }
    if (method === 'thread/read') return reply({ thread: threads.get(params.threadId).thread })
    if (method === 'thread/turns/list') {
      return client.send(JSON.stringify({ id, error: { code: -32600, message: 'thread/turns/list is unavailable before first user message' } }))
    }
    if (method === 'thread/settings/update') {
      reply({})
      const { client: creator } = threads.get(params.threadId)
      confirm = () => creator.send(JSON.stringify({ method: 'thread/settings/updated',
        params: { threadId: params.threadId, threadSettings: workspace } }))
      update.resolve(params)
      return
    }
    if (method === 'thread/queue/add') {
      enqueued.push(params.threadId)
      threads.get(params.threadId).thread.status.type = 'active'
      return reply({ queuedSubmission: { id: 'queued', clientUserMessageId: params.clientUserMessageId } })
    }
    assert.fail(`unexpected ${method}`)
  }))
  const routes = createHistoryRoutes(socket, owner.signal)
  function post(path, fields) {
    const route = routes.find(route => route.path === `/api/codex/${path}`)
    return route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields),
    }))
  }

  const saved = await post('permission-action', { action: 'default', profileId: ':read-only' })
  assert.equal(saved.status, 200)
  assert.deepEqual(starters, [])
  const request = { action: 'prompt', threadId: 'web-new-30e49fb8-c38f-44ab-a918-3512c85445fd',
    newSession: { cwd: directory }, mode: 'queue', input: [{ type: 'text', text: '请继续' }] }
  const byDefault = await post('conversation-action', { ...request, clientUserMessageId: 'with-default' })
  assert.equal(byDefault.status, 200)
  assert.equal((await byDefault.json()).permission.profileId, ':read-only')
  assert.equal(starters[0].permissions, ':read-only')

  const explicit = post('conversation-action', { ...request, clientUserMessageId: 'explicit', permissionDraft: ':workspace' })
  const params = await Promise.race([update.promise, explicit.then(response => assert.fail(`首发尚未确认权限，返回 ${response.status}`))])
  assert.deepEqual(params, { threadId: 'thread-2', permissions: ':workspace' })
  assert.equal(starters[1].permissions, ':workspace')
  assert.deepEqual(enqueued, ['thread-1'])
  const released = once(threads.get(params.threadId).client, 'close', { signal: AbortSignal.timeout(1_000) })
  confirm()
  const response = await explicit
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).permission, expected)
  assert.deepEqual(enqueued, ['thread-1', 'thread-2'])
  await released
})

async function blankThread(t) {
  const { createPermissionActions } = await import('../src/host/permissions.mjs')
  const { directory, socket, ws } = await permissionServer(t)
  const owner = new AbortController()
  t.after(() => owner.abort())
  const threadId = 'draft'
  const thread = { id: threadId, cwd: directory, status: { type: 'idle' }, historyMode: 'paginated', preview: '' }
  const initial = { activePermissionProfile: { id: ':read-only' }, sandbox: { type: 'readOnly' } }
  const updated = Promise.withResolvers()
  let creator
  ws.on('connection', client => client.on('message', raw => {
    const { id, method, params } = JSON.parse(raw)
    if (id === undefined) return
    const reply = result => client.send(JSON.stringify({ id, result }))
    if (method === 'initialize') return reply({})
    if (method === 'thread/start') {
      creator = client
      return reply({ thread, ...initial })
    }
    if (method === 'thread/read') return reply({ thread })
    if (method === 'permissionProfile/list') return reply({ data: [{ id: ':workspace', allowed: true }] })
    if (method === 'thread/settings/update') {
      reply({})
      updated.resolve(params)
      return
    }
    assert.fail(`unexpected ${method}`)
  }))
  const permissions = createPermissionActions(socket, owner.signal)
  await permissions.withThreadCreation(new AbortController().signal, async (rpc, retain) => {
    retain(await rpc('thread/start', { cwd: directory, historyMode: 'paginated' }))
  })
  const notify = (method, params) => creator.send(JSON.stringify({ method, params: { threadId, ...params } }))
  return { permissions, owner, threadId, creator, updated: updated.promise, notify }
}

test('旧式创建订阅空闲 60 秒后释放，后台目录和设置读取不续期', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { permissions, threadId, creator } = await blankThread(t)
  t.mock.timers.tick(59_999)
  const catalog = await permissions.catalogRoute.fetch(new Request(`http://localhost${permissions.catalogRoute.path}?threadId=${threadId}`))
  assert.equal((await catalog.json()).permission.source, 'runtime')
  assert.equal(permissions.readDraftSettings(threadId).thread.id, threadId)
  const closed = once(creator, 'close', { signal: AbortSignal.timeout(1_000) })
  t.mock.timers.tick(1)
  await closed
  assert.equal(permissions.readDraftSettings(threadId), undefined)
})

test('设置确认跨过创建订阅空闲期限时保持订阅，操作结束后重新计时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { permissions, threadId, creator, updated, notify } = await blankThread(t)
  t.mock.timers.tick(59_999)
  const selection = permissions.switchPermission(threadId, ':workspace', new AbortController().signal)
  assert.deepEqual(await updated, { threadId, permissions: ':workspace' })
  t.mock.timers.tick(1)
  const settings = { activePermissionProfile: { id: ':workspace' }, sandbox: { type: 'workspaceWrite' } }
  notify('thread/settings/updated', { threadSettings: settings })
  const { permission } = await selection
  assert.equal(permission.profileId, ':workspace')
  assert.equal(permission.source, 'runtime')
  t.mock.timers.tick(59_999)
  assert.deepEqual(permissions.readDraftSettings(threadId), settings)
  const closed = once(creator, 'close', { signal: AbortSignal.timeout(1_000) })
  t.mock.timers.tick(1)
  await closed
})

test('创建订阅收到主动释放请求后继续接收设置确认，直到显式操作结束', async t => {
  const { permissions, threadId, creator, notify } = await blankThread(t)
  const end = permissions.holdCreation(threadId)
  const confirmed = Promise.withResolvers()
  const settings = { activePermissionProfile: { id: ':workspace' }, sandbox: { type: 'workspaceWrite' } }
  const stop = permissions.observeDraftSettings(threadId, value => {
    if (value.activePermissionProfile.id === ':workspace') confirmed.resolve(value)
  })
  const closed = once(creator, 'close', { signal: AbortSignal.timeout(1_000) })
  permissions.releaseCreation(threadId)
  notify('thread/settings/updated', { threadSettings: settings })
  assert.deepEqual(await Promise.race([
    confirmed.promise,
    closed.then(() => assert.fail('创建订阅在设置确认前关闭')),
  ]), settings)
  stop()
  assert.deepEqual(permissions.readDraftSettings(threadId), settings)
  end()
  await closed
  assert.equal(permissions.readDraftSettings(threadId), undefined)
})

test('Host 退出时关闭仍在等待设置确认的创建订阅', async t => {
  const { permissions, owner, threadId, creator } = await blankThread(t)
  const stop = permissions.observeDraftSettings(threadId, () => {})
  const closed = once(creator, 'close', { signal: AbortSignal.timeout(1_000) })
  owner.abort()
  await closed
  stop()
  assert.equal(permissions.readDraftSettings(threadId), undefined)
})
