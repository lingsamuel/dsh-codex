import { openCodexReader } from './app-server.mjs'
import { readCatalogEvent } from './catalog-events.mjs'
import { watchNativeHistory } from './history-watch.mjs'
import { createHistoryTail, readItemTailCursor, readThreadTurns } from './live-history.mjs'
import { createRolloutFacts } from './rollout-facts.mjs'
import { watchNativeUnread } from './unread-watch.mjs'
import { watchConversationQueue } from './queue-watch.mjs'
import { modelSelectionOf } from '../shared/model-selection.js'

const encoder = new TextEncoder()
const catalogMethods = new Set([
  'thread/started', 'thread/status/changed', 'thread/readState/changed', 'thread/name/updated', 'thread/project/updated',
  'thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/section/changed', 'project/changed',
])
const goalMethods = new Set(['thread/goal/updated', 'thread/goal/cleared'])

/** 只消费 daemon 广播和原生历史读取增量，连接生命周期归当前 SSE 请求。 */
export function createWatchRoute(socketPath, ownerSignal, questions, backgroundTerminals) {
  return {
    path: '/api/codex/watch',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const params = new URL(request.url).searchParams
      const threadId = params.get('threadId')
      const catalog = params.get('scope') === 'catalog'
      const observeBackgroundTerminals = catalog && params.get('backgroundTerminals') === '1'
      const observeQueue = params.get('queue') === '1'
      const observeQuestions = !catalog && params.get('questions') === '1'
      if (!catalog && !threadId) return Response.json({ error: '缺少 Codex 线程 ID。' }, { status: 400 })
      const resumeCursor = threadId && (request.headers.get('Last-Event-ID') || params.get('itemCursor'))
      const abort = new AbortController()
      const signal = AbortSignal.any([request.signal, abort.signal, ...(ownerSignal ? [ownerSignal] : [])])
      let cancelled = false

      const stream = new ReadableStream({
        start(writer) {
          const send = frame => {
            if (!signal.aborted && !cancelled) writer.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          }
          const heartbeat = setInterval(() => {
            if (!signal.aborted && !cancelled) writer.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'))
          }, 15_000)
          heartbeat.unref()
          let timer
          let reading = false
          let dirty = false
          let reset = false
          let tail
          let pendingReadState
          let awaitingPreview
          let receiptSequence = 0
          let rolloutFacts
          let settingsStamp
          let wakeQueue
          let connection
          let catalogReady = false
          let catalogQueue = Promise.resolve()
          let mode
          let sentCursor = resumeCursor || ''
          const early = []
          const questionObserver = observeQuestions ? questions?.observe(threadId, send, signal) : undefined

          function checkpoint(cursor = '') {
            cursor ??= ''
            if (cursor === sentCursor || signal.aborted || cancelled) return
            // SSE 断线后使用该 ID 请求续读，必须在这一批历史条目发完后确认进度。
            sentCursor = cursor
            writer.enqueue(encoder.encode(`id: ${cursor}\nevent: history-checkpoint\ndata: {}\n\n`))
          }

          async function sendFacts() {
            const facts = await rolloutFacts?.read()
            if (!facts || signal.aborted) return
            const { settingsStamp: stamp, ...projection } = facts
            send({ type: 'rollout-facts', ...projection })
            if (stamp === settingsStamp) return
            settingsStamp = stamp
            // 旁路连接不会成为线程订阅者。原生设置落盘时仅读回该线程的当前模型。
            const result = await connection.request('thread/read', { threadId }).catch(error => {
              connection.close(error)
            })
            if (result && settingsStamp === stamp) send({ type: 'model-selection', selection: modelSelectionOf(result.thread) })
          }

          function wake() {
            dirty = true
            if (!tail || reading || timer || signal.aborted) return
            timer = setTimeout(async () => {
              timer = undefined
              if (signal.aborted) return
              dirty = false
              reading = true
              const readState = pendingReadState
              const receipt = receiptSequence
              pendingReadState = undefined
              try {
                const updates = reset ? null : await tail.readChanges()
                if (!updates || reset) {
                  reset = false
                  const reading = await connection.request('thread/read', { threadId })
                  await sendSnapshot(reading, true)
                } else {
                  for (const update of updates) send({ type: 'change', ...update })
                  checkpoint(tail.itemCursor())
                  if (awaitingPreview && updates.some(({ items }) => items.some(item => item.type === 'userMessage'))) {
                    // 状态可能先于首条消息落盘。观察到已保存的用户条目后读回原生预览。
                    const result = await connection.request('thread/read', { threadId }).catch(() => null)
                    if (result?.thread.name || result?.thread.preview) {
                      awaitingPreview = false
                      send({ type: 'thread-summary', ...result })
                    }
                  }
                  // Codex 在保存新结果后才广播回执。在读取并发出该历史后暴露此版本。
                  if (readState !== undefined && receipt === receiptSequence) send({ type: 'reading-receipt', readState })
                }
                await sendFacts()
              } catch (error) {
                if (!reset) connection.close(error)
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
            if ((message.params?.threadId ?? message.params?.thread?.id) !== threadId) return
            if (message.method === 'thread/queue/changed') {
              wakeQueue?.()
              return
            }
            const goal = goalMethods.has(message.method)
            const settings = message.method === 'thread/settings/updated'
            const reverted = message.method === 'thread/reverted'
            if (!catalogMethods.has(message.method) && !goal && !settings && !reverted) return
            if (!tail) { early.push(message); return }
            if (message.method === 'thread/status/changed') questionObserver?.update(message.params.status)
            if (message.method === 'thread/archived' || message.method === 'thread/deleted') questionObserver?.update(null)
            if (reverted) {
              // 原生回退会使已有游标失效。尾部读取和原生通知均可触发快照重建。
              reset = true
              wake()
              return
            }
            if (message.method === 'thread/readState/changed') {
              receiptSequence++
              pendingReadState = undefined
              const { readState } = message.params
              if (readState?.firstUnread == null) send({ type: 'reading-receipt', readState })
              else { pendingReadState = readState; wake() }
              return
            }
            send({ type: 'notification', notification: message })
            if (message.method === 'thread/archived' || message.method === 'thread/unarchived') {
              // 原生归档会移动 rollout。浏览器重连后按新路径观察，不沿用旧文件和历史游标。
              connection.close()
              return
            }
            if (!goal && !settings) wake()
          }

          async function sendSnapshot({ thread, readState }, replace = false) {
            const itemCursor = thread.historyMode === 'paginated' ? await readItemTailCursor(connection.request, threadId) : undefined
            const page = await readThreadTurns(connection.request, {
              threadId, limit: 25, sortDirection: 'desc', itemsView: 'full',
            })
            const fromCursor = !replace && itemCursor && resumeCursor ? resumeCursor : itemCursor
            tail = createHistoryTail(connection.request, thread, page, fromCursor)
            awaitingPreview = !thread.name && !thread.preview
            send({ type: 'snapshot', page, status: thread.status, readState, historyMode: thread.historyMode,
              selection: modelSelectionOf(thread), canAcceptDirectInput: thread.canAcceptDirectInput, archived: thread.archived,
              mode, ...(!awaitingPreview && { threadSummary: thread }), ...(replace && { replace: true }) })
            if (fromCursor === itemCursor) checkpoint(itemCursor)
            else wake()
            questionObserver?.update(thread.status)
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
                if (observeBackgroundTerminals) backgroundTerminals?.watch(send, signal)
                await connection.closed
                return
              }
              const [reading, config] = await Promise.all([
                connection.request('thread/read', { threadId }),
                configRead,
              ])
              const { thread } = reading
              rolloutFacts = createRolloutFacts(thread.path, signal, threadId)
              const watching = watchNativeHistory({
                thread,
                sqliteHome: sqliteDirectory(config),
              }, wake, signal)
              mode = watching ? 'live' : 'history'
              await sendSnapshot(reading)
              if (observeQueue) wakeQueue = watchConversationQueue(connection.request, threadId, sqliteDirectory(config), send, signal)
              for (const message of early) notify(message)
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
