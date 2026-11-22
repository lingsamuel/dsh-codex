import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CodexRpcError } from './app-server.mjs'
import { readConversationQueue } from './thread-runtime.mjs'
import { watchNativeFiles } from './history-watch.mjs'

function queueDatabase(sqliteHome) {
  return sqliteHome && isAbsolute(sqliteHome) ? join(sqliteHome, 'queue_1.sqlite') : undefined
}

/** 归档后原生接口拒绝读取，持久化队列仍完整保留。这里只读取观察线程的记录。 */
function readArchivedQueue(path, threadId) {
  using db = new DatabaseSync(path, { readOnly: true })
  const rows = db.prepare('SELECT id, payload_json FROM queued_items WHERE thread_id = ? ORDER BY queue_order').all(threadId)
  return rows.map(({ id, payload_json }) => {
    const { client_id: clientUserMessageId, content } = JSON.parse(payload_json).UserInput
    const input = content.map(part => {
      if (part.type === 'text' && part.text_elements?.length) {
        // 持久化的 Core 文本范围使用 snake_case，网页接收 App Server 的 v2 表示。
        return { ...part, text_elements: part.text_elements.map(({ byte_range, ...element }) =>
          byte_range ? { ...element, byteRange: byte_range } : element) }
      }
      if (part.type !== 'image' || !('image_url' in part)) return part
      const { image_url: url, ...fields } = part
      return { ...fields, url }
    })
    return { id, clientUserMessageId, input }
  })
}

/** 让归档队列的显示和附件下载使用同一个只读快照。 */
export async function readVisibleConversationQueue(request, threadId, getSqliteHome, signal) {
  try {
    return await readConversationQueue(request, threadId)
  } catch (error) {
    if (signal.aborted || !(error instanceof CodexRpcError) || error.code !== -32600
      || !error.message.startsWith(`session ${threadId} is archived.`)) throw error
    const path = queueDatabase(await getSqliteHome())
    signal.throwIfAborted()
    if (!path) throw error
    return readArchivedQueue(path, threadId)
  }
}

/** 被动观察本地原生队列。App Server 明确拒绝读取归档线程时，使用只读的落盘快照。 */
export function watchConversationQueue(request, threadId, sqliteHome, publish, signal, steers) {
  const path = queueDatabase(sqliteHome)
  let last
  let nativeQueue
  let revision
  let timer
  let reading = false
  let dirty = false
  let fileDirty = false

  function readRevision() {
    if (!path) return undefined
    try {
      using db = new DatabaseSync(path, { readOnly: true })
      return db.prepare('SELECT revision FROM queued_thread_revisions WHERE thread_id = ?').get(threadId)?.revision ?? null
    } catch {
      // 旧库或暂不可读的库仍使用 WAL 提示触发原生队列读取。
      return undefined
    }
  }

  function wake() {
    dirty = true
    schedule()
  }

  function schedule() {
    if (timer || reading || signal.aborted) return
    timer = setTimeout(async () => {
      timer = undefined
      reading = true
      const forced = dirty
      dirty = fileDirty = false
      try {
        const next = readRevision()
        if (!forced && next !== undefined && next === revision) return
        let fetched = false
        const readQueue = async () => {
          fetched = false
          const data = await readVisibleConversationQueue(request, threadId, () => sqliteHome, signal)
          fetched = true
          return data
        }
        const { data: submissions, steers: records, native } = steers ? await steers.read(request, threadId, () => nativeQueue, readQueue)
          : { data: await readQueue(), steers: [] }
        if (submissions === undefined && !records.length && last === undefined) return
        // 读取期间的共享写入只有影响本会话时，才会使这份快照过期。
        if (dirty || signal.aborted || (fileDirty && (next === undefined || readRevision() !== next))) return
        if (fetched) revision = next
        if (native) nativeQueue = native
        const frame = { type: 'queue', submissions: submissions ?? [], ...(records.length && { steers: records }) }
        const stamp = JSON.stringify(frame)
        if (stamp !== last) {
          last = stamp
          publish(frame)
        }
      } catch {
        // 队列是可选的原生数据。临时读失败不影响聊天历史与状态流。
      } finally {
        reading = false
        if (dirty || fileDirty) schedule()
      }
    }, 100)
    timer.unref()
  }

  if (path) watchNativeFiles([path, `${path}-wal`], () => {
    fileDirty = true
    schedule()
  }, signal)
  const unsubscribe = steers?.subscribe(threadId, change => {
    // 原生读失败时沿用最后成功的原生队列，再应用已经确认的取走或重新入队回执。
    if (change?.removedId && nativeQueue) nativeQueue = nativeQueue.filter(item => item.id !== change.removedId)
    if (change?.restored && !nativeQueue?.some(item => item.id === change.restored.id)) nativeQueue = [...(nativeQueue ?? []), change.restored]
    wake()
  })
  signal.addEventListener('abort', () => {
    clearTimeout(timer)
    unsubscribe?.()
  }, { once: true })
  wake()
  return wake
}
