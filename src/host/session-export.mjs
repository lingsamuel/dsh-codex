import { CodexRpcError, readCodexPages, withCodexReader } from './app-server.mjs'
import { readThreadTurns } from './live-history.mjs'

/** 从当前历史头倒序读取全部原生分页，导出时保留会话的加载与归档状态。 */
export function createSessionExportRoute(socketPath, ownerSignal, renderMarkdown) {
  return {
    path: '/api/codex/session-export',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const threadId = new URL(request.url).searchParams.get('threadId')?.trim()
      if (!threadId) return new Response('缺少 Codex 线程 ID。', { status: 400 })
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      try {
        const markdown = await withCodexReader(socketPath, signal, async rpc => {
          const { thread } = await rpc('thread/read', { threadId })
          const turns = await readCodexPages(cursor => readThreadTurns(rpc, {
            threadId, sortDirection: 'desc', itemsView: 'full', limit: 25, ...(cursor && { cursor }),
          }))
          signal.throwIfAborted()
          return renderMarkdown(thread, turns.reverse())
        }, 90_000)
        return new Response(markdown, {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      } catch (error) {
        if (signal.aborted) return new Response(null, { status: 408 })
        const missing = error instanceof CodexRpcError && error.message.startsWith('thread not found')
        return new Response(missing ? '找不到 Codex 会话。' : '无法读取完整的 Codex 会话历史。', { status: missing ? 404 : 502 })
      }
    },
  }
}
