import assert from 'node:assert/strict'
import test from 'node:test'
import { webModeFor, singleCodexFor } from '../src/shared/web-mode.js'

test('共存模式下地址优先，新开的空白入口使用 profile 默认值', () => {
  const preferences = { coexist: true, exclusive: false, defaultMode: 'codex' }
  assert.equal(webModeFor(preferences, 'dsh'), 'dsh')
  assert.equal(webModeFor(preferences, 'codex'), 'codex')
  assert.equal(webModeFor(preferences, null), 'codex')
  assert.equal(singleCodexFor(preferences), false)
})

test('单模式和独占模式覆盖显式 URL，独占优先于保存的默认模式', () => {
  const dshOnly = { coexist: false, exclusive: false, defaultMode: 'dsh' }
  assert.equal(webModeFor(dshOnly, 'codex'), 'dsh')
  assert.equal(singleCodexFor(dshOnly), false)
  assert.equal(singleCodexFor({ ...dshOnly, defaultMode: 'codex' }), true)
  assert.equal(webModeFor({ ...dshOnly, exclusive: true }, 'dsh'), 'codex')
  assert.equal(singleCodexFor({ ...dshOnly, exclusive: true }), true)
})

test('改共存默认值不重组，关闭共存才统一实例，退出独占恢复偏好', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  let preferences = { coexist: true, exclusive: false, defaultMode: 'dsh' }
  const applied = []
  const route = createWebModeRoute({ get: key => key === 'hmr' ? {} : undefined, on() {} }, {
    get preferences() { return preferences },
    async save(value) { preferences = value },
    async reconcile(value) { applied.push(value) },
    masked() { return applied.at(-1) ?? false },
    ready: () => true,
  })
  const set = patch => route.fetch(new Request('http://localhost/api/codex/web-mode', { method: 'POST', body: JSON.stringify(patch) }))
  assert.equal((await set({ defaultMode: 'codex' })).status, 200)
  assert.deepEqual(applied, [])
  assert.equal((await set({ coexist: false })).status, 200)
  assert.deepEqual(applied, [true])
  assert.equal((await set({ defaultMode: 'dsh' })).status, 200)
  assert.equal((await set({ exclusive: true })).status, 200)
  assert.equal((await set({ exclusive: false })).status, 200)
  assert.deepEqual(applied, [true, false, true, false])
  assert.deepEqual(preferences, { coexist: false, exclusive: false, defaultMode: 'dsh' })
})

test('目标装配失败时还原先前模式和偏好', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  const preferences = { coexist: true, exclusive: false, defaultMode: 'dsh' }
  let masked = false
  const route = createWebModeRoute({ get: key => key === 'hmr' ? {} : undefined, on() {} }, {
    preferences,
    async save() { assert.fail('未就绪的设置不应保存') },
    async reconcile(value) { masked = value; if (value) throw new Error('启动失败') },
    masked: () => masked,
    ready: () => true,
  })
  const response = await route.fetch(new Request('http://localhost/api/codex/web-mode', {
    method: 'POST', body: JSON.stringify({ exclusive: true }),
  }))
  assert.equal(response.status, 500)
  assert.equal((await response.json()).mode, 'dsh')
  assert.equal(masked, false)
})

test('恢复页可以修复磁盘已是 DSH 但原生控制器尚未启动的状态', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  let ready = false
  const route = createWebModeRoute({ get: key => key === 'hmr' ? {} : undefined, on() {} }, {
    preferences: { coexist: true, exclusive: false, defaultMode: 'dsh' },
    masked: () => false,
    ready: () => ready,
    async save() {},
    async reconcile(value) { assert.equal(value, false); ready = true },
  })
  const path = 'http://localhost/api/codex/web-mode'
  assert.equal((await (await route.fetch(new Request(path))).json()).mode, 'recovery')
  const response = await route.fetch(new Request(path, { method: 'POST', body: '{"restore":true}' }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).mode, 'dsh')
})

test('旧共存标签页只能保存默认偏好，不能触发整实例重组', async () => {
  const { createWebModeRoute } = await import('../src/host/web-mode.mjs')
  const route = createWebModeRoute({ get: key => key === 'hmr' ? {} : undefined, on() {} }, {
    preferences: { coexist: false, exclusive: false, defaultMode: 'dsh' },
    masked: () => false,
    ready: () => true,
    async save() { assert.fail('旧标签页不能覆盖实例模式') },
    async reconcile() { assert.fail('旧标签页不能触发装配切换') },
  })
  const response = await route.fetch(new Request('http://localhost/api/codex/web-mode', {
    method: 'POST', body: JSON.stringify({ defaultMode: 'codex', keepPage: true }),
  }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).mode, 'dsh')
})

test('Codex 启动图保持本页的控制器和独立插件', async () => {
  const { selectCodexBoot } = await import('../src/shared/dual-web-entry.js')
  const session = '@deepseek-ai/dsh-api-session-controller'
  const hmr = '@deepseek-ai/dsh-client-hmr'
  const graph = {
    entries: [{ id: session }, { id: hmr }, { id: 'dsh-chatgpt', inject: [session, hmr] }, { id: 'custom-plugin' }],
    batches: [{ phase: 'bootstrap', entries: [session, hmr] }, { phase: 'lazy', entries: ['dsh-chatgpt', 'custom-plugin'] }],
  }
  assert.deepEqual(selectCodexBoot(graph), {
    entries: [{ id: 'dsh-chatgpt', inject: [] }, { id: 'custom-plugin' }],
    batches: [{ phase: 'lazy', entries: ['dsh-chatgpt', 'custom-plugin'] }],
  })
})
