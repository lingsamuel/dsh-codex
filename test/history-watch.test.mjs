import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { watch } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { watchNativeHistory } from '../src/host/history-watch.mjs'

async function fixture(t) {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'watch-'))
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, controller }
}

test('监听配置的 SQLite 目录，包括新建和替换后的历史 WAL', async t => {
  const { directory, controller } = await fixture(t)
  const sqliteHome = join(directory, 'sqlite')
  await mkdir(sqliteHome)
  const wal = join(sqliteHome, 'thread_history_1.sqlite-wal')
  const replacement = join(sqliteHome, 'replacement')
  await writeFile(replacement, 'new WAL')

  const changes = new EventEmitter()
  const waitForChange = () => once(changes, 'change', { signal: AbortSignal.timeout(2_000) })
  assert.equal(watchNativeHistory({ codexHome: directory, sqliteHome }, () => changes.emit('change'), controller.signal), true)

  const firstChange = waitForChange()
  await rename(replacement, wal)
  await firstChange

  const nextChange = waitForChange()
  await appendFile(wal, 'updated WAL')
  await nextChange

  const databaseChange = waitForChange()
  await writeFile(join(sqliteHome, 'thread_history_1.sqlite'), 'checkpoint')
  await databaseChange
})

test('仅监听目标 rollout，取消后停止报告文件变更', async t => {
  const { directory, controller } = await fixture(t)
  const otherController = new AbortController()
  t.after(() => otherController.abort())
  const path = join(directory, 'rollout.jsonl')
  await writeFile(path, '')
  let cancelledEvents = 0
  const observed = new EventEmitter()
  const options = { thread: { path }, codexHome: directory }
  assert.equal(watchNativeHistory(options, () => cancelledEvents++, otherController.signal), true)
  assert.equal(watchNativeHistory(options, () => observed.emit('change'), controller.signal), true)
  otherController.abort()

  let activeEvents = 0
  observed.on('change', () => activeEvents++)
  await writeFile(join(directory, 'another-rollout.jsonl'), '')
  const indexed = new EventEmitter()
  watch(directory, { signal: controller.signal }, (_, filename) => {
    if (filename === 'state_5.sqlite-wal') indexed.emit('change')
  })
  const indexChange = once(indexed, 'change', { signal: AbortSignal.timeout(2_000) })
  await writeFile(join(directory, 'state_5.sqlite-wal'), '')
  await indexChange
  assert.equal(activeEvents, 0)

  const changed = once(observed, 'change', { signal: AbortSignal.timeout(2_000) })
  await appendFile(path, '{}\n')
  await changed
  assert.equal(cancelledEvents, 0)
})

test('已取消的调用或不存在的监听目录不会创建监听器', async t => {
  const { directory, controller } = await fixture(t)
  const unexpectedChange = () => assert.fail('收到无可用监听器的变更')
  assert.equal(watchNativeHistory({ codexHome: directory }, unexpectedChange, AbortSignal.abort()), false)
  assert.equal(watchNativeHistory({ codexHome: join(directory, 'missing') }, unexpectedChange, controller.signal), false)
})
