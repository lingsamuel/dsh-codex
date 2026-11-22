import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { watchNativeFiles } from './history-watch.mjs'

/** Codex 只向线程订阅者发未读通知。被动跟随者观察本机原生回执，不恢复线程。 */
export function watchNativeUnread(sqliteHome, publish, signal) {
  if (!sqliteHome || !isAbsolute(sqliteHome) || signal.aborted) return
  const path = join(sqliteHome, 'state_5.sqlite')
  let previous
  let timer

  function read() {
    let current
    try {
      using db = new DatabaseSync(path, { readOnly: true })
      const rows = db.prepare('SELECT thread_id FROM thread_read_receipts WHERE first_unread_turn IS NOT NULL').all()
      current = new Set(rows.map(row => row.thread_id))
    } catch {
      // 无可读状态库时，仍可使用 App Server 回执。短暂读取失败时保留上一份快照。
      return
    }
    const added = [...current].filter(id => !previous?.has(id))
    const removed = previous ? [...previous].filter(id => !current.has(id)) : []
    if (!previous || added.length || removed.length) publish({ type: 'unread', replace: !previous, added, removed })
    previous = current
  }

  if (!watchNativeFiles([path, `${path}-wal`], () => {
    timer ??= setTimeout(() => { timer = undefined; read() }, 120)
  }, signal)) return
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  read()
}
