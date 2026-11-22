import { Button, IconSearchOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage } from '../api.js'

const slot = 'conversation.session.header.utilities'
const locale = 'codex.history.search'
const copy = {
  zh: { title: '在会话中搜索', search: '搜索', close: '关闭', more: '更多结果', busy: '正在查询…', empty: '没有找到消息。', unavailable: '这条消息已无法定位。' },
  en: { title: 'Search conversation', search: 'Search', close: 'Close', more: 'More results', busy: 'Searching…', empty: 'No matching messages.', unavailable: 'This message is no longer available.' },
}

function MessageSearch({ sessionId, findMessage, useSession, t }) {
  const historyMode = useSession(state => state.historyMode)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [page, setPage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef()
  const button = useRef()
  useEffect(() => () => operation.current?.abort(), [])
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

  function reveal(hit) {
    void run(async signal => {
      const target = await findMessage(sessionId, hit, signal)
      signal.throwIfAborted()
      if (!target) throw new Error(t('unavailable'))
      const scope = button.current?.closest('[data-slot="conversation.content"]') ?? document
      // DSH 会按节点种类和身份生成锚点。保持原生聊天组件和折叠行为。
      const key = `${target.kind.length}:${target.kind}${target.id}`
      const selector = `[data-chat-node-key="${CSS.escape(key)}"]`
      const node = scope.querySelector(selector)
      if (!node) throw new Error(t('unavailable'))
      node.closest('[hidden="until-found"]')?.dispatchEvent(new Event('beforematch'))
      close()
      requestAnimationFrame(() => node.scrollIntoView({ block: 'center' }))
    })
  }

  return <>
    <Button ref={button} variant="toolbar" size="sm" aria-label={t('title')} title={t('title')}
      icon={<IconSearchOutlineRegular size={16} />} onClick={() => setOpen(true)} />
    <Modal open={open} onClose={close} title={t('title')} closeLabel={t('close')}>
      <form onSubmit={event => { event.preventDefault(); search(text.trim()) }}>
        <Input type="search" aria-label={t('search')} data-modal-autofocus value={text}
          onChange={event => setText(event.target.value)} />
        <Button type="submit" disabled={busy || !text.trim()}>{t('search')}</Button>
      </form>
      {busy && <p role="status">{t('busy')}</p>}
      {error && <p role="alert">{error}</p>}
      {page?.data.length === 0 && <p>{t('empty')}</p>}
      {page?.data.map(hit => {
        const { start, end } = hit.snippetMatchRange
        return <div key={`${hit.turnId}:${hit.itemId}:${start}:${end}:${hit.snippet}`}>
          <Button disabled={busy} onClick={() => reveal(hit)}>
            {hit.snippet.slice(0, start)}<mark>{hit.snippet.slice(start, end)}</mark>{hit.snippet.slice(end)}
          </Button>
        </div>
      })}
      {page?.nextCursor && <Button disabled={busy} onClick={() => search(page.searchTerm, page.nextCursor)}>{t('more')}</Button>}
    </Modal>
  </>
}

/** 分页历史中的消息定位复用 DSH 对话标题栏与原生弹窗。 */
export function installMessageSearch(ctx) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.inject(['sessions'], scope => {
    scope.slots.inject(slot, () => scope.slots.register({
      name: slot, id: 'codex-message-search', order: 20, locale,
      inject: () => ({ findMessage: (id, hit, signal) => scope.sessions.binding(id)?.session.findMessage(hit, signal) }),
    }, MessageSearch))
  })
}
