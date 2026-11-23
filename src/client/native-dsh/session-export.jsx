import { Button, IconCopyOutlineRegular, IconDownloadOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionMarkdownCopyController } from '@deepseek-ai/dsh-session-log-export/src/client/copy-controller.ts'
import { SessionMarkdownCopyToast } from '@deepseek-ai/dsh-session-log-export/src/client/CopyToast.tsx'
import { NS, en, es, fr, de, ru, pt, ja, zh } from '@deepseek-ai/dsh-session-log-export/src/client/locales.ts'
import { useEffect, useState } from 'react'
import { readSessionMarkdown, requestSessionMarkdown } from '../api.js'
import { CommandModal } from './command-action.jsx'

export function downloadMarkdown(markdown, title, prefix = 'codex-') {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown; charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${prefix}${title.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 120)}.md`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** 在 DSH 原生标题栏菜单中使用 Codex 历史，复制沿用 DSH 的剪贴板控制器。 */
export function installSessionExport(ctx, t) {
  ctx.inject(['contextMenus', 'sessions'], scope => {
    const downloads = new AbortController()
    const copy = new SessionMarkdownCopyController((input, options) => {
      const sessionId = new URL(input, document.baseURI).searchParams.get('sessionId')
      return requestSessionMarkdown(sessionId, options?.signal)
    })
    scope.effect(() => () => {
      downloads.abort()
      return copy.dispose()
    })
    scope.effect(() => scope.locale.register(NS, { en, es, fr, de, ru, pt, ja, zh }))
    const exportText = scope.locale.bind(NS)
    const icons = {
      'codex.export.copy': IconCopyOutlineRegular,
      'codex.export.download': IconDownloadOutlineRegular,
    }
    scope.slots.inject('contextMenu.icon', function* () {
      for (const [key, Icon] of Object.entries(icons)) {
        yield scope.slots.register({ name: 'contextMenu.icon', key }, Icon)
      }
    })
    scope.effect(() => scope.contextMenus.register({
      id: 'codex.export', target: 'sessionHeader', order: 100,
      observe: () => [scope.locale, copy.store],
      resolve({ sessionId }) {
        const state = scope.sessions.binding(sessionId)?.session.getSnapshot()
        if (!state || state.localDraft) return []
        const title = scope.sessions.list.getSnapshot().byId[sessionId]?.displayTitle || sessionId
        return [
          {
            id: 'copy', label: exportText('menu.copyMarkdown'), icon: { key: 'codex.export.copy' },
            disabled: copy.store.getSnapshot().copying,
            run: () => copy.copy(sessionId),
          },
          {
            id: 'download', label: t('export.download'), icon: { key: 'codex.export.download' },
            failureLabel: t('export.downloadFailed'),
            async run() {
              try {
                const markdown = await readSessionMarkdown(sessionId, downloads.signal)
                if (!downloads.signal.aborted) downloadMarkdown(markdown, title)
              } catch (error) {
                if (!downloads.signal.aborted) throw error
              }
            },
          },
        ]
      },
    }))
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'codex-export-copy-toast', locale: NS,
      inject: () => ({ hooks: { sessionMarkdownCopy: copy.store }, dismiss: () => copy.dismiss() }),
    }, SessionMarkdownCopyToast))
  })
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
