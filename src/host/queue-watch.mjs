import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CodexRpcError } from './app-server.mjs'
import { readConversationQueue } from './thread-runtime.mjs'
import { watchNativeFiles } from './history-watch.mjs'

/** 归档后原生接口拒绝读取，持久化队列仍完整保留。这里只读取观察线程的记录。 */
function readArchivedQueue(path, threadId) {
  using db = new DatabaseSync(path, { readOnly: true })
  const rows = db.prepare('SELECT id, payload_json FROM queued_items WHERE thread_id = ? ORDER BY queue_order').all(threadId)
  return rows.map(({ id, payload_json }) => {
    const { client_id: clientUserMessageId, content } = JSON.parse(payload_json).UserInput
    const input = content.map(part => {
      if (part.type !== 'image' || !('image_url' in part)) return part
      const { image_url: url, ...fields } = part
      return { ...fields, url }
    })
    return { id, clientUserMessageId, input }
  })
}

/** 被动观察本地原生队列。App Server 明确拒绝读取归档线程时，使用只读的落盘快照。 */
export function watchConversationQueue(request, threadId, sqliteHome, publish, signal) {
  const path = sqliteHome && isAbsolute(sqliteHome) ? join(sqliteHome, 'queue_1.sqlite') : undefined
  let last
  let timer
  let reading = false
  let dirty = false

  function wake() {
    dirty = true
    if (timer || reading || signal.aborted) return
    timer = setTimeout(async () => {
      timer = undefined
      reading = true
      dirty = false
      try {
        const submissions = await readConversationQueue(request, threadId).catch(error => {
          if (!path || signal.aborted || !(error instanceof CodexRpcError) || error.code !== -32600
            || !error.message.startsWith(`session ${threadId} is archived.`)) throw error
          return readArchivedQueue(path, threadId)
        })
        const stamp = JSON.stringify(submissions)
        if (!dirty && !signal.aborted && stamp !== last) {
          last = stamp
          publish({ type: 'queue', submissions })
        }
      } catch {
        // 队列是可选的原生数据。临时读失败不影响聊天历史与状态流。
      } finally {
        reading = false
        if (dirty) wake()
      }
    }, 100)
    timer.unref()
  }

  if (path) watchNativeFiles([path, `${path}-wal`], wake, signal)
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  wake()
  return wake
}
