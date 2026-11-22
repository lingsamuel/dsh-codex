import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage } from '../api.js'
import { parseVisualizeReference, visualizeFence } from '../native-chat/visualize.js'

const slot = 'conversation.chat.markdown.fence'
const locale = 'codex.visualize'
const labels = {
  zh: { title: 'Visualize 预览', loading: '正在加载 Visualize 预览…', expand: '展开预览', close: '退出展开' },
  en: { title: 'Visualize preview', loading: 'Loading Visualize preview…', expand: 'Expand preview', close: 'Exit expanded preview' },
}

function Preview({ sessionId, path, title, wide, t }) {
  const frame = useRef(null)
  const container = useRef(null)
  const [result, setResult] = useState(null)
  const [height, setHeight] = useState(384)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    readPage('visualize', { threadId: sessionId, path }, signal).then(({ html }) => {
      if (!signal.aborted) setResult({ html })
    }, error => {
      if (!signal.aborted) setResult({ error: error.message })
    })
    return () => controller.abort()
  }, [sessionId, path])

  useEffect(() => {
    function resize(event) {
      const message = event.data
      // 只消费当前预览外层发送的尺寸，片段在另一个沙箱中运行。
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || message?.type !== 'dsh-visualize-height') return
      if (Number.isFinite(message.height)) setHeight(Math.max(64, Math.min(1200, Math.ceil(message.height))))
    }
    function fullscreen() {
      setExpanded(document.fullscreenElement === container.current)
    }
    window.addEventListener('message', resize)
    document.addEventListener('fullscreenchange', fullscreen)
    return () => {
      window.removeEventListener('message', resize)
      document.removeEventListener('fullscreenchange', fullscreen)
    }
  }, [])

  if (!result) return <p role="status">{t('loading')}</p>
  if (result.error) return <p role="alert">{result.error}</p>

  return <div ref={container} style={expanded ? {
    display: 'grid', alignContent: 'center', justifyItems: 'center', gap: '0.5rem',
    padding: '1rem', background: 'Canvas', color: 'CanvasText',
  } : undefined}>
    <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={result.html}
      style={{ display: 'block', border: 0, height, maxHeight: expanded ? 'calc(100dvh - 5rem)' : '70dvh',
        width: expanded ? 'min(1024px, 100%)' : '100%', colorScheme: 'inherit' }} />
    {wide && document.fullscreenEnabled && <Button size="sm" variant="toolbar" onClick={() => {
      const action = expanded ? document.exitFullscreen() : container.current.requestFullscreen()
      void action.catch(() => {})
    }}>{t(expanded ? 'close' : 'expand')}</Button>}
  </div>
}

function VisualizeFence({ code, streaming, sessionId, children, t }) {
  const reference = !streaming && parseVisualizeReference(code.trim())
  if (!reference) return children
  const { path, mode, title } = reference
  return <Preview key={JSON.stringify([sessionId, path])} sessionId={sessionId} path={path} wide={mode === 'wide'}
    title={typeof title === 'string' && title.trim() ? title : t('title')} t={t} />
}

/** 在原生聊天的 Markdown 流中绘制 Codex 历史预览。 */
export function installVisualizePreview(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'codex-visualize-preview', key: visualizeFence, locale }, VisualizeFence))
}
