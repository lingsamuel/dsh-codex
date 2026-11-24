import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createHistoryPreferences } from '../src/host/history-preferences.mjs'

const defaults = { firstItems: 1000, firstMiB: 1, openTurns: 15, manualTurns: 15, prefetch: true }
const routeUrl = 'http://localhost/api/codex/history-preferences'

function post(route, body) {
  return route.fetch(new Request(routeUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
}

async function profiles(t) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'history-preferences-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('未保存时浏览器与 Host 读取相同的历史加载默认设置', async () => {
  const { route, get } = createHistoryPreferences()
  const response = await route.fetch(new Request(routeUrl))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), defaults)
  assert.deepEqual(await get(), defaults)
})

test('历史加载设置按 Profile 保存，重新打开时读取保存的数量和预算', async t => {
  const directory = await profiles(t)
  const personal = join(directory, 'personal')
  const { route } = createHistoryPreferences(personal)
  const custom = { firstItems: 3200, firstMiB: 0.5, openTurns: 3, manualTurns: 45, prefetch: false }
  const response = await post(route, custom)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), custom)
  assert.deepEqual(await createHistoryPreferences(personal).get(), custom)
  assert.deepEqual(await createHistoryPreferences(join(directory, 'work')).get(), defaults)
})

test('旧有偏好文件缺少字段或含无效值时补齐默认设置', async t => {
  const directory = await profiles(t)
  await writeFile(join(directory, 'web-history-preferences.json'), JSON.stringify({
    preferences: { firstMiB: 2.25, openTurns: 2, manualTurns: '20', prefetch: false },
  }))
  assert.deepEqual(await createHistoryPreferences(directory).get(), { ...defaults, firstMiB: 2.25, prefetch: false })
})

test('无效输入保留此前保存的历史加载偏好', async () => {
  const { route, get } = createHistoryPreferences()
  const saved = { ...defaults, manualTurns: 25 }
  assert.equal((await post(route, saved)).status, 200)
  for (const invalid of [{ openTurns: 2 }, { firstItems: 2.5 }, { firstMiB: 0 }, { manualTurns: -1 }, { prefetch: 'false' }]) {
    assert.equal((await post(route, { ...defaults, ...invalid })).status, 400)
  }
  assert.deepEqual(await get(), saved)
})

test('不同设置的自动应用并发提交时合并到同一 Profile', async t => {
  const directory = await profiles(t)
  const { route } = createHistoryPreferences(directory)
  const responses = await Promise.all([
    post(route, { firstMiB: 0.5 }),
    post(route, { openTurns: 20 }),
    post(route, { prefetch: false }),
  ])
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200])
  assert.deepEqual(await createHistoryPreferences(directory).get(), { ...defaults, firstMiB: 0.5, openTurns: 20, prefetch: false })
})
