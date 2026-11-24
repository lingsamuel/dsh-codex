import { codexSqliteHome, openCodexReader } from './app-server.mjs'
import { readCatalogEvent } from './catalog-events.mjs'
import { watchNativeHistory } from './history-watch.mjs'
import { createHistoryTail, readItemTail, readThreadTurns } from './live-history.mjs'
import { createRolloutFacts } from './rollout-facts.mjs'
import { createNativeUnreadMonitor } from './unread-watch.mjs'
import { watchConversationQueue } from './queue-watch.mjs'
import { modelSelectionOf } from '../shared/model-selection.js'
import { readOpeningHistory } from './history-window.mjs'
import { defaultHistoryPreferences } from '../shared/history-preferences.js'

const encoder = new TextEncoder()
const heartbeatFrame = encoder.encode('event: heartbeat\ndata: {}\n\n')
const restartFrame = encoder.encode('event: watch-restart\ndata: {}\n\n')
const maxQueuedBytes = 2 * 1024 * 1024
const maxPendingNotifications = 512
const chunkBytes = 64 * 1024
const catalogMethods = new Set([
  'thread/started', 'thread/status/changed', 'thread/readState/changed', 'thread/name/updated', 'thread/project/updated',
  'thread/settings/updated', 'thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/section/changed', 'project/changed',
])
const goalMethods = new Set(['thread/goal/updated', 'thread/goal/cleared'])

/** 每个批次沿用 change 帧。终态只随本轮最后一个批次或随后的空批次发送。 */
function* historyChangeFrames({ turn, items, onlyIfLoaded }, lastPage) {
  const { status, completedAt, durationMs, error, ...ongoing } = turn
  const initial = !onlyIfLoaded && status && status !== 'inProgress' ? ongoing : turn
  const prefixFor = fields => `data: ${JSON.stringify({ type: 'change', turn: fields, ...(onlyIfLoaded && { onlyIfLoaded }) }).slice(0, -1)},"items":[`
  const prefix = prefixFor(initial)
  const suffix = ']}\n\n'
  const overhead = Buffer.byteLength(prefix) + suffix.length
  const parts = []
  let length = overhead
  const encodeBatch = start => {
    const bytes = encoder.encode(start + parts.join(',') + suffix)
    // 等待下游时仅保留编码后的当前批次，不保留该批次的序列化字符串。
    parts.length = 0
    length = overhead
    return bytes
  }
  for (const item of items) {
    const part = JSON.stringify(item)
    const bytes = Buffer.byteLength(part)
    if (parts.length && length + 1 + bytes > maxQueuedBytes) yield encodeBatch(prefix)
    if (parts.length) length++
    parts.push(part)
    length += bytes
  }

  const finalPrefix = lastPage && initial !== turn ? prefixFor(turn) : prefix
  if (parts.length && finalPrefix !== prefix
    && length - overhead + Buffer.byteLength(finalPrefix) + suffix.length > maxQueuedBytes) {
    yield encodeBatch(prefix)
  }
  yield encodeBatch(finalPrefix)
}

/** 只消费 daemon 广播和原生历史读取增量，连接生命周期归当前 SSE 请求。 */
export function createWatchRoute(socketPath, ownerSignal, questions, backgroundTerminals, readDraftPlanMode, steers, readPreferences,
  watchTitleHistory) {
  const watchNativeUnread = createNativeUnreadMonitor()
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
      let onPull
      let clearFrames

      const stream = new ReadableStream({
        start(writer) {
          const frames = []
          let queuedBytes = 0
          let largeFrameQueued = false
          let waiting = false
          let ended = false

          function flush() {
            if (waiting && frames.length) {
              const frame = frames[0]
              const { bytes, offset, consumed } = frame
              const end = Math.min(offset + chunkBytes, bytes.byteLength)
              waiting = false
              // HTTP 层只持有本次读取的块，连接关闭后可直接释放其余大帧字节。
              writer.enqueue(end === bytes.byteLength && offset === 0 ? bytes : bytes.slice(offset, end))
              frame.offset = end
              if (end === bytes.byteLength) {
                frames.shift()
                if (consumed) consumed()
                else if (bytes.byteLength > maxQueuedBytes) largeFrameQueued = false
                else queuedBytes -= bytes.byteLength
              }
            }
            if (ended && !frames.length) writer.close()
          }

          function push(bytes, consumed) {
            if (signal.aborted) { consumed?.(); return }
            if (!consumed) {
              const large = bytes.byteLength > maxQueuedBytes
              if (large ? largeFrameQueued : queuedBytes + bytes.byteLength > maxQueuedBytes) {
                abort.abort()
                return
              }
              // 待发队列等原生快照可以单独超过预算，允许一帧随下游分块读取。
              if (large) largeFrameQueued = true
              else queuedBytes += bytes.byteLength
            }
            frames.push({ bytes, consumed, offset: 0 })
            flush()
          }

          onPull = () => { waiting = true; flush() }
          clearFrames = () => {
            for (const { consumed } of frames) consumed?.()
            frames.length = 0
          }
          const encodeFrame = frame => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
          const send = frame => { if (!signal.aborted) push(encodeFrame(frame)) }
          // 历史读取串行等待当前帧发完，积压时只保留正在发送的历史帧。
          const writeHistory = bytes => new Promise(resolve => push(bytes, resolve))
          const heartbeat = setInterval(() => {
            if (waiting) push(heartbeatFrame)
          }, 15_000)
          heartbeat.unref()
          let timer
          // 快照发送期间合并文件变化，避免并行读取和积压下一帧历史。
          let reading = true
          let dirty = false
          let factsDirty = false
          let reset = false
          let tail
          let pendingReadState
          let awaitingPreview
          let receiptSequence = 0
          let rolloutFacts
          let observedThread
          let historyWatch
          let sqliteHome
          let settingsStamp
          let confirmedCwd
          let wakeQueue
          let connection
          let catalogReady = false
          let readingCatalog = false
          let pendingBytes = 0
          let mode
          let sentCursor = resumeCursor || ''
          const pendingNotifications = []

          function stop() {
            pendingNotifications.length = 0
            clearTimeout(timer)
            clearInterval(heartbeat)
            if (ended) {
              // 主动归档时只保留已排队的数据，解除正在等待写入的历史读取任务。
              for (const { consumed } of frames) consumed?.()
              return
            }
            ended = true
            clearFrames()
            if (!cancelled) writer.close()
          }
          signal.addEventListener('abort', stop, { once: true })
          if (signal.aborted) { stop(); return }

          const questionObserver = observeQuestions ? questions?.observe(threadId, send, signal) : undefined

          function checkpoint(cursor = '') {
            cursor ??= ''
            if (cursor === sentCursor || signal.aborted) return
            // SSE 断线后使用该 ID 请求续读，必须在这一批历史条目发完后确认进度。
            sentCursor = cursor
            push(encoder.encode(`id: ${cursor}\nevent: history-checkpoint\ndata: {}\n\n`))
          }

          async function sendFacts() {
            const path = observedThread.path
            if (!path) return
            rolloutFacts ??= createRolloutFacts(path, signal, threadId)
            const facts = await rolloutFacts?.read({ path, changesOnly: true })
            if (!facts || signal.aborted) return
            const { settingsStamp: stamp, ...projection } = facts
            if (Object.keys(projection).length) send({ type: 'rollout-facts', ...projection })
            if (stamp === undefined || stamp === settingsStamp) return
            settingsStamp = stamp
            // 旁路连接不会成为线程订阅者。原生设置落盘时仅读回该线程的当前模型。
            const result = await connection.request('thread/read', { threadId }).catch(error => {
              connection.close(error)
            })
            if (result && settingsStamp === stamp) {
              send({ type: 'model-selection', selection: modelSelectionOf(result.thread) })
              if (result.thread.cwd !== confirmedCwd) {
                confirmedCwd = result.thread.cwd
                send({ type: 'thread-summary', thread: result.thread })
              }
            }
          }

          function wake() {
            dirty = true
            scheduleRead()
          }

          function wakeFacts() {
            factsDirty = true
            scheduleRead()
          }

          function scheduleRead() {
            if (!tail || reading || timer || signal.aborted) return
            timer = setTimeout(async () => {
              timer = undefined
              if (signal.aborted) return
              const readHistory = dirty
              dirty = factsDirty = false
              reading = true
              const readState = pendingReadState
              const receipt = receiptSequence
              pendingReadState = undefined
              try {
                if (readHistory) {
                  let changed = false
                  let sawUserInput = false
                  const isCurrent = () => !reset && !signal.aborted
                  const complete = isCurrent() && await tail.readChanges(async (update, lastPage) => {
                    if (!isCurrent()) return false
                    for (const bytes of historyChangeFrames(update, lastPage)) {
                      await writeHistory(bytes)
                      signal.throwIfAborted()
                      if (reset) return false
                    }
                    changed = true
                    sawUserInput ||= awaitingPreview && update.items.some(item => item.type === 'userMessage')
                  }, isCurrent)
                  signal.throwIfAborted()
                  if (!complete || reset) {
                    reset = false
                    const reading = await connection.request('thread/read', { threadId })
                    await sendSnapshot(reading, true)
                  } else {
                    if (changed && steers?.list(observedThread.id).length) wakeQueue?.()
                    checkpoint(tail.itemCursor())
                    const partial = tail.partialTurns()
                    if (partial.length) send({ type: 'history-details-changed', turnIds: partial })
                    if (sawUserInput) {
                      // 状态可能先于首条消息落盘。观察到已保存的用户条目后读回原生预览。
                      const result = await connection.request('thread/read', { threadId }).catch(() => null)
                      if (result?.thread.name || result?.thread.preview) {
                        awaitingPreview = false
                        followHistory(result.thread)
                        send({ type: 'thread-summary', ...result })
                      }
                    }
                    // Codex 在保存新结果后才广播回执。在读取并发出该历史后暴露此版本。
                    if (readState !== undefined && receipt === receiptSequence) send({ type: 'reading-receipt', readState })
                  }
                }
                await sendFacts()
              } catch (error) {
                if (!reset) connection.close(error)
              } finally {
                reading = false
                if (dirty || factsDirty) scheduleRead()
              }
            }, 120)
          }

          function queueNotification(message, bytes) {
            if (pendingNotifications.length >= maxPendingNotifications
              || (pendingNotifications.length && pendingBytes + bytes > maxQueuedBytes)) {
              abort.abort()
              return
            }
            // 原生单条大通知仍可处理，等待队列不能叠加更多数据。
            pendingNotifications.push({ message, bytes })
            pendingBytes += bytes
          }

          function takeNotification() {
            const { message, bytes } = pendingNotifications.shift()
            pendingBytes -= bytes
            return message
          }

          async function readCatalogUpdates() {
            if (!catalogReady || readingCatalog) return
            readingCatalog = true
            try {
              while (!signal.aborted && pendingNotifications.length) {
                try {
                  const update = await readCatalogEvent(takeNotification(), connection.request)
                  if (update) send(update)
                } catch (error) {
                  // 实体可能在读回前已删除，紧随其后的删除事件仍会同步目录。
                  if (error.code === -32602) continue
                  connection.close(error)
                  return
                }
              }
            } finally {
              readingCatalog = false
            }
          }

          function notify(message, bytes) {
            // 只处理通知。账户和服务端交互请求不进入此通道。
            if (signal.aborted || message.id !== undefined) return
            if (catalog) {
              if (!catalogMethods.has(message.method)) return
              queueNotification(message, bytes)
              void readCatalogUpdates()
              return
            }
            if ((message.params?.threadId ?? message.params?.thread?.id) !== (observedThread?.id ?? threadId)) return
            if (message.method === 'thread/queue/changed') {
              wakeQueue?.()
              return
            }
            const goal = goalMethods.has(message.method)
            const settings = message.method === 'thread/settings/updated'
            const reverted = message.method === 'thread/reverted'
            if (!catalogMethods.has(message.method) && !goal && !settings && !reverted) return
            if (!tail) { queueNotification(message, bytes); return }
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
            if (!signal.aborted && (message.method === 'thread/archived' || message.method === 'thread/unarchived')) {
              // 归档状态变化会移动 rollout。让浏览器处理完已有帧后立即按新路径观察。
              push(restartFrame)
              if (signal.aborted) return
              ended = true
              flush()
              abort.abort()
              return
            }
            if (!goal && !settings) wake()
          }

          function followHistory(thread) {
            if (observedThread && observedThread.path === thread.path && observedThread.historyMode === thread.historyMode) return
            // 分页回退可更换文件。先挂上新的监听，再读快照，避免漏掉并发追加。
            historyWatch?.abort()
            historyWatch = new AbortController()
            observedThread = thread
            const watching = watchNativeHistory({ thread, sqliteHome }, wake,
              AbortSignal.any([signal, historyWatch.signal]), wakeFacts)
            mode = watching ? 'live' : 'history'
          }

          async function sendSnapshot({ thread, readState }, replace = false, goal) {
            followHistory(thread)
            confirmedCwd = thread.cwd
            const itemHead = thread.historyMode === 'paginated' ? await readItemTail(connection.request, threadId) : undefined
            const itemCursor = itemHead?.cursor
            const preferences = await readPreferences?.().catch(() => defaultHistoryPreferences)
            const page = preferences ? await readOpeningHistory(connection.request, thread, sqliteHome, preferences)
              : await readThreadTurns(connection.request, { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full' })
            const fromCursor = !replace && itemCursor && resumeCursor ? resumeCursor : itemCursor
            tail = createHistoryTail(connection.request, thread, page, fromCursor, fromCursor === itemCursor ? itemHead : undefined)
            awaitingPreview = !thread.name && !thread.preview
            const writing = writeHistory(encodeFrame({ type: 'snapshot', page, status: thread.status, readState, historyMode: thread.historyMode,
              planMode: readDraftPlanMode?.(threadId), goal,
              selection: modelSelectionOf(thread), canAcceptDirectInput: thread.canAcceptDirectInput, archived: thread.archived,
              mode, preferences, ...(!awaitingPreview && { threadSummary: thread }), ...(replace && { replace: true }) }))
            if (fromCursor === itemCursor) checkpoint(itemCursor)
            else wake()
            questionObserver?.update(thread.status)
            while (pendingNotifications.length) notify(takeNotification())
            await writing
            signal.throwIfAborted()
          }

          async function follow() {
            try {
              connection = await openCodexReader(socketPath, signal, notify)
              // 初始快照可一直等待下游。原生连接的寿命独立于历史写入的进度。
              void connection.closed.then(() => abort.abort())
              const configRead = connection.request('config/read', { includeLayers: false }).catch(() => null)
              const sqliteDirectory = config => codexSqliteHome(config, connection.initialize.codexHome)
              if (catalog) {
                const sqliteHome = sqliteDirectory(await configRead)
                signal.throwIfAborted()
                catalogReady = true
                send({ type: 'catalog-ready' })
                void readCatalogUpdates()
                watchNativeUnread(sqliteHome, send, signal)
                if (observeBackgroundTerminals) backgroundTerminals?.watch(send, signal)
                await connection.closed
                return
              }
              const [initial, config, goalResult] = await Promise.all([
                connection.request('thread/read', { threadId }),
                configRead,
                connection.request('thread/goal/get', { threadId }).catch(() => undefined),
              ])
              sqliteHome = sqliteDirectory(config)
              await sendSnapshot(initial, false, goalResult?.goal)
              reading = false
              watchTitleHistory?.(initial.thread.id, send, signal)
              if (observeQueue) wakeQueue = watchConversationQueue(connection.request, initial.thread.id, sqliteHome, send, signal, steers)
              wakeFacts()
              await connection.closed
            } catch {
              // 浏览器重连时重新读取一次原生尾部快照。
            } finally {
              abort.abort()
              connection?.close()
            }
          }
          void follow()
        },
        pull() { onPull() },
        cancel() {
          cancelled = true
          clearFrames()
          abort.abort()
        },
      }, { highWaterMark: 0 })

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
