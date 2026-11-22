import { watch } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** 监听本地 Codex 历史文件的变更提示，调用方须通过 App Server 获取内容。 */
export function watchNativeHistory({ thread, codexHome, sqliteHome }, onChange, signal) {
  const paths = []
  const databaseHome = sqliteHome ?? codexHome
  if (databaseHome && isAbsolute(databaseHome)) {
    const database = join(databaseHome, 'thread_history_1.sqlite')
    paths.push(database, `${database}-wal`)
  }
  if (thread?.path && isAbsolute(thread.path)) paths.push(thread.path)
  return watchNativeFiles(paths, onChange, signal)
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
