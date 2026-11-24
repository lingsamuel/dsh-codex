import { codexSqliteHome, iterateCodexPages, openCodexReader, withCodexReader } from './app-server.mjs'
import { readHistoryItemPage, readLegacyTurnDetails, readOlderHistoryTurn, readOpeningHistory } from './history-window.mjs'
import { defaultHistoryPreferences } from '../shared/history-preferences.js'
import { readHistoryItemsById } from './live-history.mjs'

async function readScope(request, initialize, threadId) {
  const [{ thread }, config] = await Promise.all([
    request('thread/read', { threadId }), request('config/read', { includeLayers: false }).catch(() => null),
  ])
  return { thread, sqliteHome: codexSqliteHome(config, initialize.codexHome) }
}

export async function readOpeningFallback(socketPath, signal, threadId, readPreferences) {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const connection = await openCodexReader(socketPath, lifetime)
  try {
    const [{ thread, sqliteHome }, preferences] = await Promise.all([
      readScope(connection.request, connection.initialize, threadId), readPreferences().catch(() => defaultHistoryPreferences),
    ])
    return { ...await readOpeningHistory(connection.request, thread, sqliteHome, preferences), preferences }
  } finally { connection.close() }
}

export function readTurnDetails(socketPath, signal, threadId, turnId, cursor, itemIds) {
  return withCodexReader(socketPath, signal, async request => {
    if (itemIds.length) return readHistoryItemsById(request, threadId, turnId, itemIds)
    if (cursor) return readHistoryItemPage(request, threadId, turnId, cursor, 25)
    const { thread } = await request('thread/read', { threadId })
    return thread.historyMode === 'paginated' ? readHistoryItemPage(request, threadId, turnId, undefined, 25)
      : readLegacyTurnDetails(request, threadId, turnId)
  }, 90_000)
}

/** 一个请求可交付多轮，每次拉取只准备下一轮，取消时立即关闭专属原生连接。 */
export function createOlderHistoryRoute(socketPath, ownerSignal, readPreferences) {
  return {
    path: '/api/codex/history-older', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams
      const threadId = query.get('threadId')
      const cursor = query.get('cursor')
      const limit = Number(query.get('limit'))
      if (!threadId || !cursor || !Number.isSafeInteger(limit) || limit <= 0) {
        return Response.json({ error: '缺少有效的历史分页参数。' }, { status: 400 })
      }
      const abort = new AbortController()
      const signal = AbortSignal.any([abort.signal, request.signal, ...(ownerSignal ? [ownerSignal] : [])])
      const encoder = new TextEncoder()
      let connection, pages, remaining
      const stop = () => { abort.abort(); connection?.close() }
      const body = new ReadableStream({
        async pull(controller) {
          try {
            if (!pages) {
              const preferences = await readPreferences().catch(() => defaultHistoryPreferences)
              remaining = Math.min(limit, Math.max(preferences.openTurns, preferences.manualTurns))
              connection = await openCodexReader(socketPath, signal)
              const { thread, sqliteHome } = await readScope(connection.request, connection.initialize, threadId)
              pages = iterateCodexPages(next => readOlderHistoryTurn(connection.request, thread, sqliteHome, next), cursor)
            }
            const { value: page } = await pages.next()
            signal.throwIfAborted()
            const done = --remaining === 0 || !page.nextCursor
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ page, done })}\n\n`))
            if (!done) return
            controller.close()
            stop()
          } catch (error) {
            if (!signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`))
            if (!abort.signal.aborted) controller.close()
            stop()
          }
        },
        cancel: stop,
      }, { highWaterMark: 0 })
      return new Response(body, { headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      } })
    },
  }
}
