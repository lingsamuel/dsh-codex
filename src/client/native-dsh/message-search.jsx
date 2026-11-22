import { Button, IconSearchOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage } from '../api.js'
import { findRenderedMessage } from './message-anchor.js'
import { renderedSearchMatch } from './message-search-match.js'

const slot = 'conversation.session.header.utilities'
const locale = 'codex.history.search'
const searchTarget = 'data-codex-message-search-target'
const matchHighlight = 'codex-message-search-match'
const copy = {
  zh: { title: '在会话中搜索', query: '搜索消息', search: '搜索', close: '关闭', more: '更多结果', busy: '正在查询…', empty: '没有找到消息。', unavailable: '这条消息已无法定位。' },
  en: { title: 'Search conversation', query: 'Search messages', search: 'Search', close: 'Close', more: 'More results', busy: 'Searching…', empty: 'No matching messages.', unavailable: 'This message is no longer available.' },
}

const searchStyles = `
  .codex-message-search[role="dialog"] { width: min(36rem, 100%); }
  .codex-message-search form {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px;
  }
  .codex-message-search form input { width: 100%; min-width: 0; }
  .codex-message-search-results {
    margin-top: 12px; max-height: min(50dvh, 28rem); overflow: auto; overscroll-behavior: contain;
  }
  .codex-message-search-results ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .codex-message-search-status { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); }
  .codex-message-search-status[role="alert"] { color: var(--dsw-alias-state-error-primary); }
  .codex-message-search button.codex-message-search-hit {
    justify-content: flex-start; width: 100%; height: auto; padding: 8px 10px; text-align: start;
  }
  .codex-message-search-hit > span { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .codex-message-search-hit mark {
    color: inherit; background: var(--dsw-alias-state-warn-secondary); border-radius: 3px;
  }
  .codex-message-search-more { width: 100%; margin-top: 4px; }
  [${searchTarget}] {
    outline: 2px solid var(--dsw-alias-state-business-primary);
    outline-offset: 2px;
    border-radius: var(--dsw-radius-sm);
    background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  }
  ::highlight(${matchHighlight}) { background-color: var(--dsw-alias-state-warn-secondary); }
`

function MessageSearch({ sessionId, findMessage, useSession, t }) {
  const historyMode = useSession(state => state.historyMode)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [page, setPage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef()
  const button = useRef()
  const clearJump = useRef()
  useEffect(() => () => {
    operation.current?.abort()
    clearJump.current?.()
  }, [])
  if (historyMode !== 'paginated') return null

  function close() {
    operation.current?.abort()
    setOpen(false)
    setBusy(false)
  }

  async function run(action) {
    operation.current?.abort()
    const abort = new AbortController()
    operation.current = abort
    setBusy(true)
    setError('')
    try {
      await action(abort.signal)
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure.message)
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }

  function search(searchTerm, cursor) {
    if (!searchTerm) return
    if (!cursor) setPage(null)
    void run(async signal => {
      const result = await readPage('search-occurrences', { threadId: sessionId, searchTerm, ...(cursor && { cursor }) }, signal)
      signal.throwIfAborted()
      setPage(previous => ({ ...result, searchTerm, data: cursor ? [...previous.data, ...result.data] : result.data }))
    })
  }

  function jumpTo(node, hit) {
    clearJump.current?.()
    let timeout
    let highlight
    // 弹窗关闭后再标记落点和滚动，避免高亮留在遮罩下或被关闭时的焦点还原遮住。
    const frame = requestAnimationFrame(() => {
      if (!node.isConnected) return clear()
      node.setAttribute(searchTarget, '')
      const range = CSS.highlights && typeof Highlight === 'function' ? renderedSearchMatch(node, hit, page) : undefined
      if (range) {
        highlight = new Highlight(range)
        CSS.highlights.set(matchHighlight, highlight)
      }
      node.scrollIntoView({ block: 'center' })
      const scrollport = range && node.closest('[data-conversation-scroll]')
      if (scrollport) {
        const match = range.getBoundingClientRect()
        const viewport = scrollport.getBoundingClientRect()
        if (match.height && (match.top < viewport.top || match.bottom > viewport.bottom)) {
          scrollport.scrollBy({ top: match.top - viewport.top + (match.height - viewport.height) / 2 })
        }
      }
      timeout = setTimeout(clear, 2500)
    })
    function clear() {
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
      node.removeAttribute(searchTarget)
      if (highlight && CSS.highlights.get(matchHighlight) === highlight) CSS.highlights.delete(matchHighlight)
      clearJump.current = undefined
    }
    clearJump.current = clear
  }

  function reveal(hit) {
    void run(async signal => {
      const target = await findMessage(sessionId, hit, signal)
      signal.throwIfAborted()
      if (!target) throw new Error(t('unavailable'))
      const scope = button.current?.closest('[data-slot="conversation.content"]') ?? document
      const node = findRenderedMessage(scope, target)
      if (!node) throw new Error(t('unavailable'))
      node.closest('[hidden="until-found"]')?.dispatchEvent(new Event('beforematch'))
      node.querySelector('[data-codex-plan-toggle][aria-expanded="false"]')?.click()
      close()
      jumpTo(node, hit)
    })
  }

  return <>
    <Button ref={button} variant="ghost" size="sm" aria-label={t('title')} title={t('title')} aria-haspopup="dialog"
      icon={<IconSearchOutlineRegular size={16} />} onClick={() => setOpen(true)} />
    <Modal className="codex-message-search" open={open} onClose={close} title={t('title')} closeLabel={t('close')}>
      <form onSubmit={event => { event.preventDefault(); search(text.trim()) }}>
        <Input type="search" aria-label={t('query')} placeholder={t('query')} autoComplete="off" data-modal-autofocus value={text}
          icon={<IconSearchOutlineRegular size={15} />}
          onChange={event => setText(event.target.value)} />
        <Button type="submit" variant="outline" disabled={busy || !text.trim()}>{t('search')}</Button>
      </form>
      {busy && <p className="codex-message-search-status" role="status">{t('busy')}</p>}
      {error && <p className="codex-message-search-status" role="alert">{error}</p>}
      {page?.data.length === 0 && <p className="codex-message-search-status" role="status">{t('empty')}</p>}
      {page?.data.length > 0 && <div className="codex-message-search-results">
        <ul>{page.data.map((hit, index) => {
          const { start, end } = hit.snippetMatchRange
          return <li key={`${hit.turnId}:${hit.itemId}:${index}`}>
            <Button className="codex-message-search-hit" disabled={busy} onClick={() => reveal(hit)}>
              <span>{hit.snippet.slice(0, start)}<mark>{hit.snippet.slice(start, end)}</mark>{hit.snippet.slice(end)}</span>
            </Button>
          </li>
        })}</ul>
        {page?.nextCursor && <Button className="codex-message-search-more" disabled={busy}
          onClick={() => search(page.searchTerm, page.nextCursor)}>{t('more')}</Button>}
      </div>}
    </Modal>
  </>
}

/** 分页历史中的消息定位复用 DSH 对话标题栏与原生弹窗。 */
export function installMessageSearch(ctx) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = searchStyles
    document.head.append(style)
    return () => style.remove()
  })
  ctx.inject(['sessions'], scope => {
    scope.slots.inject(slot, () => scope.slots.register({
      name: slot, id: 'codex-message-search', order: 20, locale,
      inject: () => ({ findMessage: (id, hit, signal) => scope.sessions.binding(id)?.session.findMessage(hit, signal) }),
    }, MessageSearch))
  })
}
