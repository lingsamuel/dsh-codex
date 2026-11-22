import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { findRenderedMessage } from './message-anchor.js'

const locale = 'codex.receipts'
const labels = { zh: { unread: '标为未读' }, en: { unread: 'Mark as unread' } }
const header = 'conversation.session.header.utilities'
const menu = 'sidebar.workspaces.session.menu.item'

function visibleEnd(node) {
  if (!node || node.closest('[hidden]') || !node.getClientRects().length) return false
  const rect = node.getBoundingClientRect()
  const scroller = node.closest('[data-conversation-scroll]')
  const viewport = scroller?.getBoundingClientRect()
  const composer = scroller?.querySelector('[data-composer-seat]')?.getBoundingClientRect()
  // 原生输入栏覆盖滚动区底部，按 DSH 聊天视口相同的可见边界确认阅读。
  const bottom = Math.min(window.innerHeight, viewport?.bottom ?? Infinity, composer?.height ? composer.top : Infinity)
  return rect.height > 0 && rect.bottom > Math.max(0, viewport?.top ?? 0)
    && rect.bottom <= bottom + 1
    && rect.right > 0 && rect.left < window.innerWidth
}

function AcknowledgeVisible({ sessionId, useSession, useCodexHistory, writeReadState }) {
  const reading = useSession(state => state.reading)
  const visit = useCodexHistory(state => state.selected?.id === sessionId ? state.readVisit : 0)
  const manualVisit = useCodexHistory(state => state.manualUnreadVisit)
  const position = useRef()
  const observation = useRef()

  useEffect(() => {
    if (!visit) return
    const receipt = reading?.readState
    if (observation.current?.visit !== visit) {
      observation.current = { visit, firstRevision: undefined, attempted: new Set(), retried: new Set() }
    }
    const observed = observation.current
    if (receipt && observed.firstRevision === undefined) observed.firstRevision = receipt.revision
    if (!receipt?.firstUnread || !reading.target || observed.attempted.has(receipt.revision)) return
    if (receipt.firstUnread.type === 'threadStart' && (manualVisit === visit || receipt.revision !== observed.firstRevision)) return

    const scope = position.current?.closest('[data-slot="main.conversation"]')
    if (!scope) return
    const lifecycle = new AbortController()
    let frame
    let retry
    function schedule() {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (lifecycle.signal.aborted || observed.attempted.has(receipt.revision)
          || document.visibilityState !== 'visible' || !document.hasFocus()
          || document.querySelector('[aria-modal="true"]') || !visibleEnd(findRenderedMessage(scope, reading.target))) return
        observed.attempted.add(receipt.revision)
        void writeReadState(sessionId, 'read', receipt.revision).catch(error => {
          // 冲突时等对应的新消息实际显示。不能用服务器返回的新版本盲目重试。
          if (lifecycle.signal.aborted || observed.retried.has(receipt.revision)
            || !(error.status >= 500 || error instanceof TypeError)) return
          observed.retried.add(receipt.revision)
          observed.attempted.delete(receipt.revision)
          retry = setTimeout(schedule, 1000)
        })
      })
    }
    const options = { capture: true, passive: true, signal: lifecycle.signal }
    for (const event of ['focus', 'resize']) window.addEventListener(event, schedule, options)
    for (const event of ['scroll', 'visibilitychange']) document.addEventListener(event, schedule, options)
    const rendered = new MutationObserver(schedule)
    rendered.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] })
    // DSH 弹窗挂在 body 下，关闭时要重新检查被遮挡的消息。
    rendered.observe(document.body, { childList: true })
    schedule()
    return () => {
      lifecycle.abort()
      rendered.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearTimeout(retry)
    }
  }, [manualVisit, reading, sessionId, visit, writeReadState])

  return <span ref={position} hidden />
}

function MarkUnread({ sessionId, useCodexHistory, useMenuOpenState, writeReadState, t }) {
  const receipt = useCodexHistory(state => state.readStates[sessionId])
  const [, setOpen] = useMenuOpenState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!receipt || receipt.firstUnread?.type === 'threadStart') return null

  async function mark() {
    setBusy(true)
    setError('')
    try {
      await writeReadState(sessionId, 'unread', receipt.revision)
      setOpen(false)
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <MenuItemButton disabled={busy} onSelect={mark}>{t('unread')}</MenuItemButton>
    {error && <span role="alert">{error}</span>}
  </>
}

/** 回执只在原生消息可见后确认，手动标未读使用原生会话菜单。 */
export function installReadReceipts(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const inject = () => ({ writeReadState: catalog.writeReadState })
  ctx.slots.inject(header, () => ctx.slots.register({ name: header, id: 'codex-visible-receipt', inject }, AcknowledgeVisible))
  ctx.slots.inject(menu, () => ctx.slots.register({ name: menu, id: 'codex-mark-unread', order: 425, locale, inject }, MarkUnread))
}
