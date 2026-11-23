import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { watchNativeFiles } from './history-watch.mjs'

function observeNativeUnread(path) {
  const abort = new AbortController()
  const subscribers = new Set()
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
    const replace = !previous
    const added = [...current].filter(id => !previous?.has(id))
    const removed = previous ? [...previous].filter(id => !current.has(id)) : []
    previous = current
    if (replace || added.length || removed.length) {
      const frame = { type: 'unread', replace, added, removed }
      for (const publish of subscribers) publish(frame)
    }
  }

  if (!watchNativeFiles([path, `${path}-wal`], () => {
    timer ??= setTimeout(() => { timer = undefined; read() }, 120).unref()
  }, abort.signal)) return
  abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  read()
  return {
    subscribers,
    stop: () => abort.abort(),
    snapshot: () => previous && { type: 'unread', replace: true, added: [...previous], removed: [] },
  }
}

/** 被动目录订阅按本机状态库共享一份原生未读观察，兼容只向线程订阅者发回执的 Codex。 */
export function createNativeUnreadMonitor() {
  const databases = new Map()
  return function watchNativeUnread(sqliteHome, publish, signal) {
    if (!sqliteHome || !isAbsolute(sqliteHome) || signal.aborted) return
    const path = join(sqliteHome, 'state_5.sqlite')
    let observation = databases.get(path)
    if (!observation) {
      observation = observeNativeUnread(path)
      if (!observation) return
      databases.set(path, observation)
    }
    observation.subscribers.add(publish)
    signal.addEventListener('abort', () => {
      observation.subscribers.delete(publish)
      if (observation.subscribers.size) return
      databases.delete(path)
      observation.stop()
    }, { once: true })
    const snapshot = observation.snapshot()
    if (snapshot) publish(snapshot)
  }
}
