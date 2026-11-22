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
