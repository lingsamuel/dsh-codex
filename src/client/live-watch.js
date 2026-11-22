/** 打开认证后的 SSE。侧栏的连接独立于当前会话的历史连接。 */
export function openLiveWatch(threadId, { receive, changeMode, queue, questions }, signal) {
  if (signal.aborted) return
  const url = new URL('api/codex/watch', document.baseURI)
  if (threadId) url.searchParams.set('threadId', threadId)
  else url.searchParams.set('scope', 'catalog')
  if (threadId && queue) url.searchParams.set('queue', '1')
  if (threadId && questions) url.searchParams.set('questions', '1')
  const source = new EventSource(url)
  source.onopen = () => changeMode?.('connecting')
  source.onerror = () => changeMode?.('disconnected')
  source.onmessage = event => receive(JSON.parse(event.data))
  signal.addEventListener('abort', () => source.close(), { once: true })
}
