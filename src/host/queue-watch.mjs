import { isAbsolute, join } from 'node:path'
import { readConversationQueue } from './conversation-actions.mjs'
import { watchNativeFiles } from './history-watch.mjs'

/** 被动观察本地原生队列。WAL 只作变更提示，队列内容和顺序始终由 App Server 提供。 */
export function watchConversationQueue(request, threadId, sqliteHome, publish, signal) {
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
        const submissions = await readConversationQueue(request, threadId)
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

  if (sqliteHome && isAbsolute(sqliteHome)) {
    const path = join(sqliteHome, 'queue_1.sqlite')
    watchNativeFiles([path, `${path}-wal`], wake, signal)
  }
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  wake()
  return wake
}
