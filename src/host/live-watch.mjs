import { openCodexReader } from './app-server.mjs'
import { readCatalogEvent } from './catalog-events.mjs'
import { watchNativeHistory } from './history-watch.mjs'
import { createHistoryTail } from './live-history.mjs'
import { createRolloutFacts } from './rollout-facts.mjs'
import { watchNativeUnread } from './unread-watch.mjs'

const encoder = new TextEncoder()
const catalogMethods = new Set([
  'thread/started', 'thread/status/changed', 'thread/readState/changed', 'thread/name/updated', 'thread/project/updated',
  'thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/section/changed', 'project/changed',
])
const goalMethods = new Set(['thread/goal/updated', 'thread/goal/cleared'])

/** 只消费 daemon 广播和原生历史读取增量，连接生命周期归当前 SSE 请求。 */
export function createWatchRoute(socketPath, ownerSignal) {
  return {
    path: '/api/codex/watch',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const params = new URL(request.url).searchParams
      const threadId = params.get('threadId')
      const catalog = params.get('scope') === 'catalog'
      if (!catalog && !threadId) return Response.json({ error: '缺少 Codex 线程 ID。' }, { status: 400 })
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
          let rolloutFacts
          let connection
          let catalogReady = false
          let catalogQueue = Promise.resolve()
          const early = []

          async function sendFacts() {
            const facts = await rolloutFacts?.read()
            if (facts) send({ type: 'rollout-facts', ...facts })
          }

          function wake() {
            dirty = true
            if (!tail || reading || timer || signal.aborted) return
            timer = setTimeout(async () => {
              timer = undefined
              if (signal.aborted) return
              dirty = false
              reading = true
              try {
                await Promise.all([tail.readChanges().then(updates => {
                  for (const update of updates) send({ type: 'change', ...update })
                }), sendFacts()])
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
            if (message.id !== undefined) return
            if (catalog) {
              if (!catalogMethods.has(message.method)) return
              if (!catalogReady) early.push(message)
              else catalogQueue = catalogQueue.then(async () => {
                if (signal.aborted) return
                const update = await readCatalogEvent(message, connection.request)
                if (update) send(update)
              }).catch(error => {
                // 实体可能在读回前已删除，紧随其后的删除事件仍会同步目录。
                if (error.code !== -32602) connection.close(error)
              })
              return
            }
            if (message.params?.threadId !== threadId) return
            const goal = goalMethods.has(message.method)
            if (!catalogMethods.has(message.method) && !goal) return
            if (!tail) early.push(message)
            else send({ type: 'notification', notification: message })
            if (message.method !== 'thread/readState/changed' && !goal) wake()
          }

          async function follow() {
            try {
              connection = await openCodexReader(socketPath, signal, notify)
              const configRead = connection.request('config/read', { includeLayers: false }).catch(() => null)
              const sqliteDirectory = config => config?.config?.sqlite_home || process.env.CODEX_SQLITE_HOME || connection.initialize.codexHome
              if (catalog) {
                const sqliteHome = sqliteDirectory(await configRead)
                signal.throwIfAborted()
                catalogReady = true
                send({ type: 'catalog-ready' })
                for (const message of early) notify(message)
                early.length = 0
                watchNativeUnread(sqliteHome, send, signal)
                await connection.closed
                return
              }
              const [{ thread, readState }, config] = await Promise.all([
                connection.request('thread/read', { threadId }),
                configRead,
              ])
              rolloutFacts = createRolloutFacts(thread.path, signal)
              const watching = watchNativeHistory({
                thread,
                sqliteHome: sqliteDirectory(config),
              }, wake, signal)
              const page = await connection.request('thread/turns/list', {
                threadId, limit: 25, sortDirection: 'desc', itemsView: 'full',
              })
              tail = createHistoryTail(connection.request, thread, page)
              send({ type: 'snapshot', page, status: thread.status, readState, mode: watching ? 'live' : 'history' })
              for (const message of early) send({ type: 'notification', notification: message })
              early.length = 0
              void sendFacts()
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
