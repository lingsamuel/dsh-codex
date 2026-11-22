import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { readSessionMarkdown } from '../api.js'
import { CommandModal } from './command-action.jsx'

function downloadMarkdown(markdown, title) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown; charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `codex-${title.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 120)}.md`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** 提前读取记录，使复制动作可在浏览器仍保留用户手势时写入剪贴板。 */
export function ExportCommand({ command, onClose, sessionId, useSessions, t }) {
  const title = useSessions(state => state.byId[sessionId]?.displayTitle) || sessionId
  const [markdown, setMarkdown] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    readSessionMarkdown(sessionId, abort.signal).then(content => {
      if (!abort.signal.aborted) setMarkdown(content)
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [sessionId])

  async function copy() {
    setError('')
    setCopied(false)
    try {
      if (!await writeClipboard(markdown)) throw new Error()
      setCopied(true)
    } catch {
      setError(t('export.copyFailed'))
    }
  }

  const footer = <>
    <Button disabled={markdown === null} onClick={copy}>{t('export.copy')}</Button>
    <Button disabled={markdown === null} variant="primary" onClick={() => downloadMarkdown(markdown, title)}>{t('export.download')}</Button>
  </>
  return <CommandModal {...{ command, onClose, t, error, footer }} unavailable={markdown === null && !error ? 'loading' : undefined}>
    {copied && <p role="status">{t('export.copied')}</p>}
  </CommandModal>
}
