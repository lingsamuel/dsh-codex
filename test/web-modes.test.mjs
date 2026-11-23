import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { webModeFor } from '../src/shared/web-mode.js'

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
  const manifest = JSON.stringify({ dsh: { profile: { bundles: ['dsh-codex'] } } })
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
    '@deepseek-ai/dsh-client-hmr',
    '@deepseek-ai/dsh-api-job-controller',
    '@deepseek-ai/dsh-api-terminal-controller',
    '@deepseek-ai/dsh-client-ui-jobs',
    '@deepseek-ai/dsh-client-ui-message-feedback',
    '@deepseek-ai/dsh-client-ui-schedule',
    '@deepseek-ai/dsh-client-ui-sidebar-terminal',
    '@deepseek-ai/dsh-client-ui-skill',
    '@deepseek-ai/dsh-session-log-export',
  ]
  const shared = '@deepseek-ai/dsh-client-ui-context-menu'
  const codex = { id: 'dsh-codex', inject: [shared, ...native] }
  const graph = {
    entries: [...native.map(id => ({ id })), { id: shared }, codex, { id: 'custom-plugin' }],
    batches: [
      { phase: 'bootstrap', entries: native },
      { phase: 'application', entries: [shared, codex.id, 'custom-plugin'] },
    ],
  }
  assert.deepEqual(selectCodexBoot(graph), {
    entries: [{ id: shared }, { ...codex, inject: [shared] }, { id: 'custom-plugin' }],
    batches: [{ phase: 'application', entries: [shared, codex.id, 'custom-plugin'] }],
  })
  assert.deepEqual(graph.entries.find(entry => entry.id === codex.id).inject, [shared, ...native])
})
