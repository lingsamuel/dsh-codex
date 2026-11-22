import { watch } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 监听本地 Codex 历史文件的变更提示，调用方须通过 App Server 获取内容。 */
export function watchNativeHistory({ thread, codexHome, sqliteHome }, onChange, signal, onRolloutChange = onChange) {
  if (signal.aborted) return false
  const databaseHome = sqliteHome ?? codexHome
  const database = databaseHome && isAbsolute(databaseHome) && thread?.historyMode !== 'legacy'
    ? join(databaseHome, 'thread_history_1.sqlite') : undefined
  // 原生回退保留会话 ID，在文件名末尾用下划线追加新的 rollout ID。
  const replacement = thread?.path && /^rollout-.*_([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\.jsonl(?:\.zst)?$/i.exec(basename(thread.path))
  const projectionId = replacement?.[1].toLowerCase() ?? thread?.id
  let checkpoint
  let timer

  function readCheckpoint() {
    if (!projectionId) return undefined
    try {
      using db = new DatabaseSync(database, { readOnly: true })
      const row = db.prepare(`SELECT next_rollout_byte_offset, next_rollout_ordinal
        FROM thread_history_projection_state WHERE thread_id = ?`).get(projectionId)
      // 成功读到缺失行表示会话尚未投影或已删除。undefined 保留给不可读的库。
      return row ? `${row.next_rollout_byte_offset}:${row.next_rollout_ordinal}` : null
    } catch {
      return undefined
    }
  }

  const watchingDatabase = database && watchNativeFiles([database, `${database}-wal`], () => {
    timer ??= setTimeout(() => {
      timer = undefined
      // Codex 将分页历史和这个线程的投影进度写入同一事务。WAL 的文件事件只负责提示核对。
      const next = readCheckpoint()
      const changed = next === undefined || next !== checkpoint
      checkpoint = next
      if (changed) onChange()
    }, 30)
  }, signal)
  if (watchingDatabase) {
    checkpoint = readCheckpoint()
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }
  const watchingRollout = !!(thread?.path && isAbsolute(thread.path) && watchNativeFiles([thread.path], () => {
    if (checkpoint == null) onChange()
    else onRolloutChange()
  }, signal))
  return !!watchingDatabase || watchingRollout
}

/** 监听原生文件目录项，保留对新建或替换后的文件的监听。 */
export function watchNativeFiles(paths, onChange, signal) {
  if (signal.aborted) return false

  const directories = new Map()
  for (const path of paths) {
    const directory = dirname(path)
    if (!directories.has(directory)) directories.set(directory, new Set())
    directories.get(directory).add(basename(path))
  }

  let watching = false
  for (const [directory, files] of directories) {
    try {
      const watcher = watch(directory, { signal, persistent: false }, (_, filename) => {
        if (!signal.aborted && files.has(filename)) onChange()
      })
      watcher.on('error', () => watcher.close())
      watching = true
    } catch {
      // 本地目录可能尚未创建，或不在服务所处的文件系统中。
    }
  }
  return watching
}
