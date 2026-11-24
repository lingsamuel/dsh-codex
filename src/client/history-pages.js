import { EventSourceParserStream } from 'eventsource-parser/stream'

/** 等当前轮交付完成后再读取下一轮，避免在浏览器中累计待投影的历史。 */
export async function readOlderHistory(threadId, cursor, limit, receive, signal) {
  const url = new URL('api/codex/history-older', document.baseURI)
  url.search = new URLSearchParams({ threadId, cursor, limit }).toString()
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
    throw new Error('无法读取更早的 Codex 历史。')
  }
  const frames = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
  for await (const frame of frames) {
    signal.throwIfAborted()
    const { page, done, error } = JSON.parse(frame.data)
    if (error) throw new Error(error)
    if (await receive(page) === false || done) return
  }
  throw signal.reason ?? new Error('Codex 历史在读取完成前中断。')
}

/** 两帧之间允许浏览器先绘制并处理输入，隐藏页面则等恢复可见或取消。 */
export function afterHistoryPaint(signal) {
  if (signal.aborted || typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise(resolve => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
    function finish() {
      cancelAnimationFrame(frame)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}
