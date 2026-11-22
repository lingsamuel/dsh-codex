import { readThreadTurns } from './live-history.mjs'
import { readConversationQueue } from './thread-runtime.mjs'

/** Host 持有被原生队列取走的完整输入，寿命独立于 HTTP 和 SSE 请求。 */
export function createQueuedSteers() {
  const pending = new Map()
  const listeners = new Map()

  function notify(threadId, nativeChange) {
    for (const wake of listeners.get(threadId) ?? []) wake(nativeChange)
  }

  function done({ threadId, item }, nativeChange) {
    const records = pending.get(threadId)
    records.delete(item.id)
    if (!records.size) pending.delete(threadId)
    notify(threadId, nativeChange)
  }

  function entries(threadId) {
    return [...(pending.get(threadId)?.values() ?? [])]
  }

  function list(threadId) {
    return entries(threadId).map(({ item, status }) => ({ item, status }))
  }

  async function match(request, threadId, data) {
    const unsettled = new Map(entries(threadId).filter(record => record.status !== 'steering' && record.item.clientUserMessageId)
      .map(record => [record, record.status]))

    function confirm(record, status, restored) {
      if (pending.get(threadId)?.get(record.item.id) === record && record.status === status) {
        done(record, { removedId: record.item.id, restored })
      }
      unsettled.delete(record)
    }

    for (const [record, status] of unsettled) {
      const { item } = record
      // 原队列 ID 可能来自删除前发出的读请求。恢复入队只能用新队列 ID 确认。
      const restored = data.find(queued => queued.clientUserMessageId === item.clientUserMessageId && queued.id !== item.id)
      if (restored) confirm(record, status, restored)
    }

    let cursor
    const seen = new Set()
    while (unsettled.size && !seen.has(cursor)) {
      seen.add(cursor)
      const page = await readThreadTurns(request, { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full',
        ...(cursor != null && { cursor }) })
      for (const turn of page.data) {
        for (const [record, status] of unsettled) {
          if (turn.items?.some(item => item.type === 'userMessage' && item.clientId === record.item.clientUserMessageId)) {
            confirm(record, status)
          } else if (turn.id === record.expectedTurnId) {
            // 该操作发起之前的轮次无法接纳它；走到原轮次却未看到回显，继续保留副本。
            unsettled.delete(record)
          }
        }
      }
      cursor = page.nextCursor
      if (cursor == null) break
    }
  }

  function subscribe(threadId, wake) {
    const callbacks = listeners.get(threadId) ?? new Set()
    callbacks.add(wake)
    listeners.set(threadId, callbacks)
    return () => {
      callbacks.delete(wake)
      if (!callbacks.size) listeners.delete(threadId)
    }
  }

  return {
    list,
    find: (threadId, id) => pending.get(threadId)?.get(id),
    begin(threadId, item, expectedTurnId) {
      const record = { threadId, item, expectedTurnId, status: 'steering' }
      const records = pending.get(threadId) ?? new Map()
      records.set(item.id, record)
      pending.set(threadId, records)
      notify(threadId)
      return record
    },
    setStatus(record, status) {
      record.status = status
      notify(record.threadId)
    },
    done,
    removed({ threadId, item }) {
      notify(threadId, { removedId: item.id })
    },
    subscribe,
    /** 重连、历史尾部更新或用户核对时，只有原生身份的正证可以清除副本。 */
    async read(request, threadId, fallback, readQueue = () => readConversationQueue(request, threadId)) {
      let dirty
      const unsubscribe = subscribe(threadId, () => { dirty = true })
      try {
        do {
          dirty = false
          let observed
          try {
            observed = await readQueue()
          } catch (error) {
            if (!fallback) throw error
          }
          // 原生快照可能跨越整个插话操作。收到这段期间的通知后重读，以免回放已取走的原项。
          if (dirty) continue
          await match(request, threadId, observed ?? []).catch(() => {})
          if (dirty) continue

          const native = observed ?? fallback()
          const steers = list(threadId)
          const trackedIds = new Set(steers.map(({ item }) => item.id))
          const trackedMessages = new Set(steers.map(({ item }) => item.clientUserMessageId).filter(Boolean))
          // 原生恢复可能在本次回执之前广播新队列 ID。此时继续使用原项副本，避免重复呈现。
          const data = native?.filter(item => !trackedIds.has(item.id) && !trackedMessages.has(item.clientUserMessageId))
          return { data, steers, native }
        } while (dirty)
      } finally {
        unsubscribe()
      }
    },
    match,
  }
}
