import timers from 'node:timers/promises'
import { readCodexPages, withCodexReader } from './app-server.mjs'

const scanIntervalMs = 10_000
const parallelReads = 12

/** 读取已加载会话的原生后台进程，供目录扫描和手动查看共用。 */
export function readBackgroundTerminals(request, threadId) {
  return readCodexPages(cursor => request('thread/backgroundTerminals/list', {
    threadId, limit: 50, ...(cursor && { cursor }),
  }))
}

async function scan(request, signal) {
  const ids = await readCodexPages(cursor => request('thread/loaded/list', { limit: 100, ...(cursor && { cursor }) }))
  const entries = []
  for (let offset = 0; offset < ids.length; offset += parallelReads) {
    signal.throwIfAborted()
    const batch = ids.slice(offset, offset + parallelReads)
    const results = await Promise.allSettled(batch.map(id => readBackgroundTerminals(request, id)))
    // 会话可能在扫描期间卸载，其他线程的快照仍然有效。
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value.length) entries.push([batch[index], result.value])
    }
  }
  return Object.fromEntries(entries)
}

/** 有目录订阅时共享低频只读扫描。停止和扫描按顺序发表，避免旧快照复活已停止的进程。 */
export function createBackgroundTerminalMonitor(socketPath, ownerSignal) {
  const watchers = new Set()
  let cycle
  let snapshot
  let signature
  let work = Promise.resolve()

  function serialize(run) {
    const pending = work.then(run)
    work = pending.catch(() => {})
    return pending
  }

  function publish(byThread) {
    if (!watchers.size) return
    const nextSignature = JSON.stringify(Object.entries(byThread).sort(([left], [right]) => left.localeCompare(right)))
    if (nextSignature === signature) return
    signature = nextSignature
    snapshot = { type: 'background-terminals', byThread }
    for (const send of watchers) send(snapshot)
  }

  async function follow(signal) {
    while (!signal.aborted) {
      await serialize(async () => {
        if (signal.aborted) return
        const byThread = await withCodexReader(socketPath, signal, request => scan(request, signal)).catch(() => ({}))
        if (!signal.aborted) publish(byThread)
      })
      await timers.setTimeout(scanIntervalMs, undefined, { signal, ref: false })
    }
  }

  return {
    watch(send, signal) {
      if (signal.aborted) return
      watchers.add(send)
      signal.addEventListener('abort', () => {
        watchers.delete(send)
        if (watchers.size) return
        cycle?.abort()
        cycle = undefined
        snapshot = undefined
        signature = undefined
      }, { once: true })
      if (snapshot) send(snapshot)
      if (cycle) return
      cycle = new AbortController()
      const active = ownerSignal ? AbortSignal.any([cycle.signal, ownerSignal]) : cycle.signal
      void follow(active).catch(() => {})
    },

    terminate(threadId, processId, signal) {
      return serialize(() => withCodexReader(socketPath, signal, async request => {
        const result = await request('thread/backgroundTerminals/terminate', { threadId, processId })
        // 原生返回后再读回，覆盖进程自行退出和其他客户端同时操作的情况。
        const rows = await readBackgroundTerminals(request, threadId).catch(() => undefined)
        const byThread = { ...snapshot?.byThread }
        if (!rows && !result.terminated) return result
        const remaining = rows ?? byThread[threadId]?.filter(terminal => terminal.processId !== processId)
        if (remaining?.length) byThread[threadId] = remaining
        else delete byThread[threadId]
        publish(byThread)
        return result
      }))
    },
  }
}
