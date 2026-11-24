import { EventSourceParserStream } from 'eventsource-parser/stream'

const idleTimeoutMs = 45_000
const retryDelayMs = 3_000

/** 打开认证后的 SSE。侧栏的连接独立于当前会话的历史连接。 */
export function openLiveWatch(threadId, { receive, changeMode, queue, questions, backgroundTerminals, itemCursor, checkpoint }, signal) {
  if (signal.aborted) return
  const url = new URL('api/codex/watch', document.baseURI)
  if (threadId) url.searchParams.set('threadId', threadId)
  else url.searchParams.set('scope', 'catalog')
  if (threadId && queue) url.searchParams.set('queue', '1')
  if (threadId && questions) url.searchParams.set('questions', '1')
  if (threadId && itemCursor) url.searchParams.set('itemCursor', itemCursor)
  if (!threadId && backgroundTerminals) url.searchParams.set('backgroundTerminals', '1')
  let connection
  let retryTimer

  async function connect() {
    if (signal.aborted) return
    const attempt = new AbortController()
    connection = attempt
    let idleTimer
    let restart = false

    function waitForBytes() {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => attempt.abort(), idleTimeoutMs)
    }

    function stopWaiting() {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }

    try {
      waitForBytes()
      const response = await fetch(url, { cache: 'no-store', signal: attempt.signal })
      stopWaiting()
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (!response.ok || !response.body || contentType !== 'text/event-stream') throw new Error('无法打开 Codex 实时同步。')
      attempt.signal.throwIfAborted()
      if (await changeMode?.('connecting', attempt.signal) === false) throw new Error('无法初始化 Codex 实时投影。')
      attempt.signal.throwIfAborted()
      const bytes = response.body.pipeThrough(new TransformStream({
        transform(chunk, stream) {
          // 大帧可能跨多个网络块。只在等待网络时按收到的字节续期，投影耗时不计入空闲。
          if (idleTimer !== undefined) waitForBytes()
          stream.enqueue(chunk)
        },
      }))
      const frames = bytes.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
      waitForBytes()
      for await (const { event, data, id } of frames) {
        stopWaiting()
        attempt.signal.throwIfAborted()
        if (event === 'watch-restart') {
          restart = true
          break
        }
        if (event === 'history-checkpoint') {
          // 只有先前帧成功投影并保存检查点后，后续连接才可以从这里续读。
          const cursor = id ?? ''
          if (await checkpoint?.(cursor, attempt.signal) === false) break
          attempt.signal.throwIfAborted()
          if (cursor) url.searchParams.set('itemCursor', cursor)
          else url.searchParams.delete('itemCursor')
        } else if (event === undefined || event === 'message') {
          if (await receive(JSON.parse(data), attempt.signal) === false) break
        }
        attempt.signal.throwIfAborted()
        waitForBytes()
      }
    } catch {
      // 网络和投影失败都从最后成功应用的检查点恢复。
    } finally {
      stopWaiting()
      attempt.abort()
      connection = undefined
    }

    if (signal.aborted) return
    if (restart) {
      // Host 主动切换历史源时，沿用最后成功应用的游标立即建立观察。
      void connect()
      return
    }
    retryTimer = setTimeout(connect, retryDelayMs)
    // 首次断开可补读 HTTP 历史。让补读跟随观察器，避免上一次连接终止时取消补读。
    await changeMode?.('disconnected', signal)
  }

  signal.addEventListener('abort', () => {
    clearTimeout(retryTimer)
    connection?.abort()
  }, { once: true })
  void connect()
}
