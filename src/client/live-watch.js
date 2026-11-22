const idleTimeoutMs = 45_000

/** 打开认证后的 SSE。侧栏的连接独立于当前会话的历史连接。 */
export function openLiveWatch(threadId, { receive, changeMode, queue, questions }, signal) {
  if (signal.aborted) return
  const url = new URL('api/codex/watch', document.baseURI)
  if (threadId) url.searchParams.set('threadId', threadId)
  else url.searchParams.set('scope', 'catalog')
  if (threadId && queue) url.searchParams.set('queue', '1')
  if (threadId && questions) url.searchParams.set('questions', '1')
  let source
  let idleTimer

  function connect() {
    if (signal.aborted) return
    const connection = new EventSource(url)
    source = connection

    function recordActivity() {
      if (source !== connection) return
      clearTimeout(idleTimer)
      // EventSource 只会在底层确认断开后重连。连续错过三次心跳时主动重新读取原生尾部。
      idleTimer = setTimeout(() => {
        connection.close()
        changeMode?.('disconnected')
        connect()
      }, idleTimeoutMs)
    }

    connection.onopen = () => {
      if (source !== connection) return
      recordActivity()
      return changeMode?.('connecting')
    }
    connection.onerror = () => {
      if (source === connection) return changeMode?.('disconnected')
    }
    connection.onmessage = event => {
      if (source !== connection) return
      recordActivity()
      return receive(JSON.parse(event.data))
    }
    connection.addEventListener('heartbeat', recordActivity)
    recordActivity()
  }

  connect()
  signal.addEventListener('abort', () => {
    clearTimeout(idleTimer)
    source?.close()
    source = undefined
  }, { once: true })
}
