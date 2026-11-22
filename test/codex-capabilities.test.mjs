import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

async function nativeRpc(t, respond) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'cap-'))
  const socketPath = join(directory, 'app.sock')
  const http = createServer()
  const sockets = new WebSocketServer({ server: http })
  const calls = []
  const owner = new AbortController()
  function notify(method, params) {
    for (const client of sockets.clients) client.send(JSON.stringify({ method, params }))
  }
  sockets.on('connection', client => client.on('message', async raw => {
    const { id, method, params } = JSON.parse(raw.toString())
    if (method === 'initialized') return
    if (method !== 'initialize') calls.push({ method, params })
    try {
      const result = method === 'initialize' ? { codexHome: directory } : await respond(method, params)
      client.send(JSON.stringify({ id, result }))
    } catch (error) {
      client.send(JSON.stringify({ id, error: { code: -32602, message: error.message } }))
    }
  }))
  http.listen(socketPath)
  await once(http, 'listening')
  t.after(async () => {
    owner.abort()
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    const closed = once(http, 'close')
    http.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  return { socketPath, signal: owner.signal, calls, notify }
}

function access(routes, path, parameters) {
  const url = new URL(`/api/codex/${path}`, 'http://local')
  const { method = 'GET', ...data } = parameters ?? {}
  const route = routes.find(route => route.path === url.pathname && route.methods.includes(method))
  assert.ok(route, path)
  if (method === 'GET') url.search = new URLSearchParams(data).toString()
  return route.fetch(new Request(url, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }))
}

test('插件目录、App 授权和安装状态读回原生 Codex，区分本地与远程来源', { timeout: 5_000 }, async t => {
  const { createCodexPluginRoutes } = await import('../src/host/codex-plugins.mjs')
  const cwd = '/test/project'
  const marketplacePath = '/test/project/.agents/plugins/marketplace.json'
  const app = { id: 'fixture-app', name: 'Fixture App', installUrl: 'https://example.invalid/app' }
  let installed = false
  const native = await nativeRpc(t, (method, params) => {
    const plugin = { id: 'notes@lab', name: 'notes', installed, enabled: installed }
    const local = { name: 'lab', path: marketplacePath, plugins: [plugin] }
    switch (method) {
      case 'plugin/list':
        assert.deepEqual(params, { cwds: [cwd] })
        return { marketplaces: [local, { name: 'remote', plugins: [{ id: 'remote_mail', name: 'mail', installed: false }] }] }
      case 'plugin/installed':
        assert.deepEqual(params, { cwds: [cwd] })
        return { marketplaces: installed ? [local] : [] }
      case 'plugin/read':
        assert.deepEqual(params, { pluginName: 'notes', marketplacePath })
        return { plugin: { summary: plugin, apps: [app], skills: [{ name: 'write' }], mcpServers: ['notes'] } }
      case 'app/list':
        if (!params.cursor) return { data: [{ id: 'unrelated', name: 'Unrelated' }], nextCursor: 'second' }
        return { data: [{ ...app, isAccessible: installed, isEnabled: true }] }
      case 'plugin/install':
        assert.deepEqual({ ...params, installAttemptId: undefined }, { pluginName: 'mail', remoteMarketplaceName: 'remote', installAttemptId: undefined })
        installed = true
        return { authPolicy: 'ON_INSTALL', appsNeedingAuth: [app] }
      case 'plugin/uninstall':
        assert.deepEqual(params, { pluginId: 'notes@lab' })
        installed = false
        return {}
      default: throw new Error(`unexpected ${method}`)
    }
  })
  const request = (path, params) => access(createCodexPluginRoutes(native.socketPath, native.signal), path, params)
  const initial = await (await request('plugins', { cwd })).json()
  assert.deepEqual(initial.installed.marketplaces, [])
  assert.deepEqual(initial.catalog.marketplaces.map(market => market.name), ['lab', 'remote'])
  const detail = { pluginName: 'notes', marketplacePath }
  assert.equal((await (await request('plugin', detail)).json()).appStates[0].isAccessible, false)
  assert.equal((await request('plugin', { ...detail, remoteMarketplaceName: 'remote' })).status, 400)
  const result = await request('plugins', { method: 'POST', action: 'install', pluginName: 'mail', remoteMarketplaceName: 'remote' })
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).appsNeedingAuth, [app])
  const refreshed = await (await request('plugins', { cwd })).json()
  assert.equal(refreshed.installed.marketplaces[0].plugins[0].id, 'notes@lab')
  const plugin = await (await request('plugin', detail)).json()
  assert.deepEqual(plugin.plugin.skills, [{ name: 'write' }])
  assert.deepEqual(plugin.plugin.mcpServers, ['notes'])
  assert.deepEqual(plugin.appStates, [{ ...app, isAccessible: true, isEnabled: true }])
  assert.equal((await request('plugins', { method: 'POST', action: 'uninstall', pluginId: 'notes@lab' })).status, 200)
  assert.deepEqual((await (await request('plugins', { cwd })).json()).installed.marketplaces, [])
})

test('读取原生 MCP 工具分页、刷新配置并关联 OAuth 完成通知', { timeout: 5_000 }, async t => {
  const { createCodexMcpRoutes } = await import('../src/host/codex-mcp.mjs')
  const name = 'notes'
  const threadId = 'fixture-thread'
  let authStatus = 'notLoggedIn'
  let reloaded = false
  const native = await nativeRpc(t, (method, params) => {
    if (method === 'config/mcpServer/reload') {
      assert.equal(params, null)
      reloaded = true
      return {}
    }
    if (method === 'mcpServer/oauth/login') {
      assert.equal(params.name, name)
      assert.equal(params.threadId, threadId)
      return { authorizationUrl: 'https://example.invalid/oauth', loginId: 'native-login' }
    }
    assert.equal(method, 'mcpServerStatus/list')
    assert.equal(params.threadId, threadId)
    assert.equal(params.detail, 'toolsAndAuthOnly')
    const notes = { name, authStatus, runtimeStatus: reloaded ? 'connected' : 'notStarted', tools: { echo: { name: 'echo' } } }
    return params.cursor ? { data: [notes] } : { data: [{ name: 'a', tools: {} }], nextCursor: 'opaque' }
  })
  const routes = createCodexMcpRoutes(native.socketPath, native.signal)
  const request = (path, params) => access(routes, path, params)
  const inventory = await (await request('mcp', { threadId })).json()
  assert.deepEqual(inventory.servers.map(server => server.name), ['a', name])
  assert.equal(inventory.servers[1].tools.echo.name, 'echo')
  const login = await (await request('mcp', { method: 'POST', action: 'login', name, threadId })).json()
  assert.equal(login.authorizationUrl, 'https://example.invalid/oauth')
  assert.ok(login.attemptId)
  const read = async () => (await request('mcp-login', { attemptId: login.attemptId })).json()
  native.notify('mcpServer/oauthLogin/completed', { name, threadId, loginId: 'other', success: true })
  assert.deepEqual(await read(), { state: 'pending' })
  authStatus = 'oAuth'
  native.notify('mcpServer/oauthLogin/completed', { name, threadId, loginId: 'native-login', success: true })
  for (let i = 0; i < 20 && (await read()).state === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(await read(), { state: 'success' })
  assert.equal((await request('mcp', { method: 'POST', action: 'reload' })).status, 200)
  const updated = await (await request('mcp', { threadId })).json()
  assert.equal(updated.servers[1].authStatus, 'oAuth')
  assert.equal(updated.servers[1].runtimeStatus, 'connected')
})
