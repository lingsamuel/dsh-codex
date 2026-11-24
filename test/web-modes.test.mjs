import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { webModeFor } from '../src/shared/web-mode.js'

const forgePanel = '@deepseek-ai/dsh-experimental-client-ui-forge'

test('共存页各自搜集待关闭终端，保留原来的终端 shell 偏好', async () => {
  const { installCodexStorageScope } = await import('../src/shared/dual-web-entry.js')
  class Storage {
    records = new Map()
    setItem(key, value) { this.records.set(key, value) }
    getItem(key) { return this.records.get(key) ?? null }
    removeItem(key) { this.records.delete(key) }
    key(index) { return [...this.records.keys()][index] ?? null }
  }
  const local = new Storage()
  const session = new Storage()
  const prefix = 'dsh.terminal.close.v1.'
  local.setItem(prefix + 'native', 'pending native')
  local.setItem('dsh.terminal.shell', '/bin/zsh')
  session.setItem(prefix + 'session', 'unrelated storage')
  installCodexStorageScope(local, Storage.prototype)
  local.setItem(prefix + 'codex', 'pending codex')
  assert.equal(local.key(0), null)
  assert.equal(local.key(1), 'dsh.terminal.shell')
  assert.equal(local.key(2), prefix + 'codex')
  assert.equal(local.getItem(prefix + 'native'), null)
  assert.equal(local.getItem(prefix + 'codex'), 'pending codex')
  assert.equal(local.getItem('dsh.terminal.shell'), '/bin/zsh')
  local.removeItem(prefix + 'codex')
  assert.equal(local.records.get(prefix + 'native'), 'pending native')
  assert.equal(session.key(0), prefix + 'session')
})

async function makeProfile(t, manifest) {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url))
  await mkdir(runtime, { recursive: true })
  const dir = await mkdtemp(join(runtime, 'web-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), manifest)
  return { dir }
}

test('独占只保存入口偏好，重开后仍覆盖显式 DSH 入口', async t => {
  const { createWebModeRoute, openWebModes } = await import('../src/host/web-mode.mjs')
  const manifest = JSON.stringify({ dsh: { profile: { bundles: ['dsh-for-codex'] } } })
  const profile = await makeProfile(t, manifest)
  const path = 'http://localhost/api/codex/web-mode?mode=dsh'
  const open = async () => createWebModeRoute(await openWebModes(profile))
  let route = await open()
  const set = patch => route.fetch(new Request(path, { method: 'POST', body: JSON.stringify(patch) }))
  const status = async () => (await route.fetch(new Request(path))).json()

  const enabled = await set({ exclusive: true })
  const result = await enabled.json()
  assert.equal(enabled.status, 200, result.error)
  assert.equal(result.mode, 'codex')
  route = await open()
  assert.equal((await status()).mode, 'codex')
  assert.equal((await set({ defaultMode: 'dsh' })).status, 409)
  assert.equal((await set({ exclusive: false })).status, 200)
  assert.deepEqual(await status(), { coexist: true, exclusive: false, defaultMode: 'dsh', mode: 'dsh', available: true })
  assert.equal(await readFile(join(profile.dir, 'package.json'), 'utf8'), manifest)
})

test('共存模式下地址优先，新开的空白入口使用 profile 默认值', () => {
  const preferences = { coexist: true, exclusive: false, defaultMode: 'codex' }
  assert.equal(webModeFor(preferences, 'dsh'), 'dsh')
  assert.equal(webModeFor(preferences, 'codex'), 'codex')
  assert.equal(webModeFor(preferences, null), 'codex')
})

test('单模式和独占模式覆盖显式 URL，独占优先于保存的默认模式', () => {
  const dshOnly = { coexist: false, exclusive: false, defaultMode: 'dsh' }
  assert.equal(webModeFor(dshOnly, 'codex'), 'dsh')
  assert.equal(webModeFor({ ...dshOnly, exclusive: true }, 'dsh'), 'codex')
})

test('共存默认值、统一入口与独占沿用同一组偏好', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  let preferences = { coexist: true, exclusive: false, defaultMode: 'dsh' }
  const route = createWebModeRoute({
    get preferences() { return preferences },
    async save(value) { preferences = value },
  })
  const path = 'http://localhost/api/codex/web-mode?mode=dsh'
  const set = async patch => {
    const response = await route.fetch(new Request(path, { method: 'POST', body: JSON.stringify(patch) }))
    assert.equal(response.status, 200)
    return (await response.json()).mode
  }
  assert.equal(await set({ defaultMode: 'codex' }), 'dsh')
  assert.equal(await set({ coexist: false }), 'codex')
  assert.equal(await set({ defaultMode: 'dsh' }), 'dsh')
  assert.equal(await set({ exclusive: true }), 'codex')
  assert.equal(await set({ exclusive: false }), 'dsh')
  assert.deepEqual(preferences, { coexist: false, exclusive: false, defaultMode: 'dsh' })
})

test('保存失败时保留原设置，并发提交收到冲突', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  const preferences = { coexist: true, exclusive: false, defaultMode: 'dsh' }
  const started = Promise.withResolvers()
  const write = Promise.withResolvers()
  const route = createWebModeRoute({
    preferences,
    save() { started.resolve(); return write.promise },
  })
  const path = 'http://localhost/api/codex/web-mode'
  const set = patch => route.fetch(new Request(path, { method: 'POST', body: JSON.stringify(patch) }))
  const first = set({ exclusive: true })
  await started.promise
  assert.equal((await set({ coexist: false })).status, 409)
  const reading = route.fetch(new Request(path))
  write.reject(new Error('无法写入'))
  const response = await first
  assert.equal(response.status, 500)
  assert.equal((await response.json()).mode, 'dsh')
  assert.deepEqual(await (await reading).json(), { ...preferences, mode: 'dsh', available: true })
})

test('旧共存标签页的侧栏开关不能覆盖已经统一的实例入口', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  const route = createWebModeRoute({
    preferences: { coexist: false, exclusive: false, defaultMode: 'dsh' },
    async save() { assert.fail('旧标签页不能覆盖实例模式') },
  })
  const response = await route.fetch(new Request('http://localhost/api/codex/web-mode', {
    method: 'POST', body: JSON.stringify({ defaultMode: 'codex', keepPage: true }),
  }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).mode, 'dsh')
})

test('Codex 启动图跳过原生会话功能并保留共用组件和独立插件', async () => {
  const { selectCodexBoot } = await import('../src/shared/dual-web-entry.js')
  const native = [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-job-controller',
    '@deepseek-ai/dsh-client-ui-jobs',
    '@deepseek-ai/dsh-client-ui-message-feedback',
    '@deepseek-ai/dsh-client-ui-schedule',
    '@deepseek-ai/dsh-client-ui-skill',
    forgePanel,
    '@deepseek-ai/dsh-session-log-export',
  ]
  const shared = '@deepseek-ai/dsh-client-ui-context-menu'
  const hotReload = '@deepseek-ai/dsh-client-hmr'
  const terminal = { id: '@deepseek-ai/dsh-api-terminal-controller' }
  const terminalTab = { id: '@deepseek-ai/dsh-client-ui-sidebar-terminal', inject: [terminal.id] }
  const codex = { id: 'dsh-for-codex', inject: [shared, ...native] }
  const graph = {
    entries: [...native.map(id => ({ id })), { id: shared }, { id: hotReload }, terminal, terminalTab, codex, { id: 'custom-plugin' }],
    batches: [
      { phase: 'bootstrap', entries: native },
      { phase: 'application', entries: [shared, hotReload, terminal.id, terminalTab.id, codex.id, 'custom-plugin'] },
    ],
  }
  assert.deepEqual(selectCodexBoot(graph), {
    entries: [{ id: shared }, { id: hotReload }, terminal, terminalTab, { ...codex, inject: [shared] }, { id: 'custom-plugin' }],
    batches: [{ phase: 'application', entries: [shared, hotReload, terminal.id, terminalTab.id, codex.id, 'custom-plugin'] }],
  })
  assert.deepEqual(graph.entries.find(entry => entry.id === codex.id).inject, [shared, ...native])
})

test('Codex 热更新沿用启动筛选，更新会话控制器前提示重新加载', async () => {
  const { installCodexGraphSync, selectCodexBoot } = await import('../src/shared/dual-web-entry.js')
  const adapter = { id: 'dsh-for-codex', rev: 'boot' }
  const native = '@deepseek-ai/dsh-api-session-controller'
  const feature = { id: 'extra-plugin', inject: [native] }
  const graph = entries => ({ release: { version: '0.2.3' }, entries, batches: [{ entries: entries.map(row => row.id) }] })
  const boot = graph([adapter])
  const applied = []
  const rebuilt = []
  let reloads = 0
  const loader = { create: () => ({
    entries: { async sync(next) { applied.push(next) }, async reload(...args) { rebuilt.push(args) } },
  }) }
  installCodexGraphSync(loader, boot, adapter.id, selectCodexBoot, () => { reloads++ })
  const { entries } = loader.create()
  await entries.sync(graph([{ id: native }, adapter, { id: forgePanel }, feature]))
  await entries.reload(feature.id, 'new')
  await entries.sync(graph([feature]))
  await entries.sync(graph([{ ...adapter, rev: 'new' }, feature]))
  await entries.reload(adapter.id, 'new')
  await entries.sync(boot)
  const otherRelease = { release: { version: '0.2.4' } }
  await entries.sync(otherRelease)
  assert.deepEqual(applied, [graph([adapter, { ...feature, inject: [] }]), boot, otherRelease])
  assert.deepEqual(rebuilt, [[feature.id, 'new']])
  assert.equal(reloads, 1)
})
