import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpcError, readCodexPages } from './app-server.mjs'

/** 从原生队列读取当前顺序。读取待发记录无需加载线程。 */
export function readConversationQueue(request, threadId) {
  return readCodexPages(cursor => request('thread/queue/list', {
    threadId, limit: 100, ...(cursor != null && { cursor }),
  }))
}

/** 从原生状态检查网页能否提交输入。浏览路径直接使用 thread/read。 */
export async function addressableThread(request, threadId, allowArchived = false) {
  const { thread } = await request('thread/read', { threadId })
  if ((!allowArchived && thread.archived) || thread.ephemeral || thread.canAcceptDirectInput === false) {
    throw new CodexRpcError({ code: -32600, message: '此会话无法从网页直接操作。', data: { reason: 'thread-unavailable' } })
  }
  return thread
}

export async function isArchived(request, threadId) {
  const { data } = await request('thread/list', { archived: true, includedThreadIds: [threadId], modelProviders: [], limit: 1 })
  return data.some(thread => thread.id === threadId)
}

/** 用户提交时才取消归档。thread/read 的 notLoaded 同样适用于未归档的冷会话。 */
export async function unarchiveForSubmission(request, thread) {
  try {
    if (!await isArchived(request, thread.id)) return addressableThread(request, thread.id)
    try {
      return (await request('thread/unarchive', { threadId: thread.id })).thread
    } catch (error) {
      // 另一客户端可能已恢复同一线程。以最新归档目录为准再接着提交。
      if (!(error instanceof CodexRpcError) || await isArchived(request, thread.id)) throw error
      return addressableThread(request, thread.id)
    }
  } catch (error) {
    if (!(error instanceof CodexRpcError)) throw error
    throw new CodexRpcError({ code: error.code, message: `无法取消归档。${error.message}`, data: { reason: 'unarchive-failed' } })
  }
}

/** 仅恢复仍未加载的会话，复查期间由 CLI 加载的会话直接复用现有运行时。 */
export async function resumeThread(request, thread, onResume) {
  if (thread.status?.type !== 'notLoaded') return thread
  const current = await addressableThread(request, thread.id)
  if (current.status?.type !== 'notLoaded') return current
  const resumed = await request('thread/resume', { threadId: thread.id, excludeTurns: true }).catch(error => {
    if (!(error instanceof CodexRpcError)) throw error
    throw new CodexRpcError({ code: error.code, data: error.data, message: `无法恢复会话。${error.message}` })
  })
  onResume?.(thread.id, resumed)
  return resumed.thread
}

/** 原生接纳提交时可能还未发布活动状态。确认这段空闲期之前不要释放刚建立的订阅。 */
export async function waitForThreadActivity(request, threadId, signal) {
  const deadline = performance.now() + 1_000
  try {
    do {
      const { thread } = await request('thread/read', { threadId })
      if (thread.status?.type !== 'idle') return
      await delay(50, undefined, { signal })
    } while (performance.now() < deadline)
  } catch {
    // 读取或连接失败时仍保留已经收到的原生提交确认。
  }
}

/** 同一 Host 按线程串行提交，避免恢复、修改历史和发送互相穿插。 */
export function createThreadSubmissionQueue() {
  const pending = new Map()
  return async (threadId, run) => {
    const previous = pending.get(threadId)
    const current = previous ? previous.then(run, run) : run()
    pending.set(threadId, current)
    try {
      return await current
    } finally {
      if (pending.get(threadId) === current) pending.delete(threadId)
    }
  }
}
