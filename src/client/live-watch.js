/** 打开认证后的原生历史 SSE，切换会话时关闭浏览器连接。 */
export function openLiveWatch(threadId, { receive, changeMode }, signal) {
  if (signal.aborted) return
  const url = new URL('api/codex/watch', document.baseURI)
  url.searchParams.set('threadId', threadId)
  const source = new EventSource(url)
  source.onopen = () => changeMode('connecting')
  source.onerror = () => changeMode('disconnected')
  source.onmessage = event => receive(JSON.parse(event.data))
  signal.addEventListener('abort', () => source.close(), { once: true })
}
