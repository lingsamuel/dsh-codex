import { openCodexReader } from './app-server.mjs'
import { watchNativeHistory } from './history-watch.mjs'
import { createHistoryTail } from './live-history.mjs'

const encoder = new TextEncoder()
const catalogMethods = new Set([
  'thread/started', 'thread/status/changed', 'thread/name/updated', 'thread/project/updated',
  'thread/archived', 'thread/unarchived', 'thread/deleted', 'project/changed',
])

/** 只消费 daemon 广播和原生历史读取增量，连接生命周期归当前 SSE 请求。 */
export function createWatchRoute(socketPath, ownerSignal) {
  return {
    path: '/api/codex/watch',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const threadId = new URL(request.url).searchParams.get('threadId')
      if (!threadId) return Response.json({ error: '缺少 Codex 线程 ID。' }, { status: 400 })
      const abort = new AbortController()
      const signal = AbortSignal.any([request.signal, abort.signal, ...(ownerSignal ? [ownerSignal] : [])])
      let cancelled = false

      const stream = new ReadableStream({
        start(writer) {
          const send = frame => {
            if (!signal.aborted && !cancelled) writer.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          }
          const heartbeat = setInterval(() => {
            if (!signal.aborted && !cancelled) writer.enqueue(encoder.encode(': keep-alive\n\n'))
          }, 15_000)
          heartbeat.unref()
          let timer
          let reading = false
          let dirty = false
          let tail
          let connection
          const early = []

          function wake() {
            dirty = true
            if (!tail || reading || timer || signal.aborted) return
            timer = setTimeout(async () => {
              timer = undefined
              if (signal.aborted) return
              dirty = false
              reading = true
              try {
                const updates = await tail.readChanges()
                for (const update of updates) send({ type: 'change', ...update })
              } catch (error) {
                connection.close(error)
              } finally {
                reading = false
                if (dirty) wake()
              }
            }, 120)
          }

          function notify(message) {
            // 只处理通知。账户和服务端交互请求不进入此通道。
            if (message.id !== undefined || !catalogMethods.has(message.method)) return
            if (!tail) early.push(message)
            else send({ type: 'notification', notification: message })
            if (message.params?.threadId === threadId) wake()
          }

          async function follow() {
            try {
              connection = await openCodexReader(socketPath, signal, notify)
              const [{ thread }, config] = await Promise.all([
                connection.request('thread/read', { threadId }),
                connection.request('config/read', { includeLayers: false }).catch(() => null),
              ])
              const watching = watchNativeHistory({
                thread,
                codexHome: connection.initialize.codexHome,
                sqliteHome: config?.config?.sqlite_home || process.env.CODEX_SQLITE_HOME || undefined,
              }, wake, signal)
              const page = await connection.request('thread/turns/list', {
                threadId, limit: 25, sortDirection: 'desc', itemsView: 'full',
              })
              tail = createHistoryTail(connection.request, thread, page)
              send({ type: 'snapshot', page, status: thread.status, mode: watching ? 'live' : 'history' })
              for (const message of early) send({ type: 'notification', notification: message })
              early.length = 0
              if (dirty) wake()
              await connection.closed
            } catch {
              // 浏览器重连时重新读取一次原生尾部快照。
            } finally {
              abort.abort()
              connection?.close()
              clearTimeout(timer)
              clearInterval(heartbeat)
              if (!cancelled) writer.close()
            }
          }
          void follow()
        },
        cancel() {
          cancelled = true
          abort.abort()
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      })
    },
  }
}
