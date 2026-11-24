import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

const occurrence = '[data-codex-history-view]'
const anchorAttribute = 'data-chat-anchor-key'
const visible = ':not([hidden]):not([hidden] *)'

function readingAnchor(scope, column, viewport) {
  const { ownerDocument } = column
  const bounds = column.getBoundingClientRect()
  const left = Math.max(0, viewport.left, bounds.left)
  const right = Math.min(ownerDocument.documentElement.clientWidth, viewport.right, bounds.right)
  const top = Math.max(0, viewport.top)
  const height = Math.min(viewport.bottom, ownerDocument.documentElement.clientHeight) - top
  if (right <= left || height <= 1) return undefined

  const x = (left + right) / 2
  for (const y of [top + 1, top + Math.min(96, height / 5)]) {
    for (const element of ownerDocument.elementsFromPoint(x, y)) {
      const row = element.closest(`[${anchorAttribute}]`)
      if (row && row.closest(occurrence) === scope && column.contains(row) &&
        !row.closest('[hidden]') && row.dataset.chatFlowKind !== 'turn-process') return row
    }
  }
}

/** 记录这一批发布前的原生聊天位置，在同一次布局中补偿旧内容的位移。 */
export function preserveHistoryPrepend(scope, publish, { manual = false } = {}) {
  const column = scope?.querySelector('[data-chat-flow]')
  if (!column || column.closest(occurrence) !== scope) return publish()
  const tail = column.closest('[data-chat-following-tail]')
  if (!manual && tail?.closest(occurrence) === scope) return publish()
  const scroller = scope.closest('[data-conversation-scroll]') ?? column.parentElement
  const viewport = scroller.getBoundingClientRect()
  const row = (scroller.scrollTop > 0.5 ? readingAnchor(scope, column, viewport) : undefined) ??
    column.querySelector(`[data-chat-paging-anchor]:not(:empty)${visible}`)
  const key = row?.dataset.chatAnchorKey
  if (!key) return publish()

  const before = row.getBoundingClientRect().top - viewport.top
  const result = flushSync(publish)
  if (!column.isConnected) return result
  // 原生分组可能重新挂载同一个节点。按稳定的锚点身份恢复，不跟随已经失效的 DOM 引用。
  const current = column.contains(row) && !row.closest('[hidden]') ? row : column.querySelector(
    `[${anchorAttribute}="${column.ownerDocument.defaultView.CSS.escape(key)}"]${visible}`,
  )
  if (current?.closest(occurrence) === scope) {
    const delta = current.getBoundingClientRect().top - scroller.getBoundingClientRect().top - before
    // 浏览器已经做过滚动锚定时，两次测量的差值为零。
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
  }
  return result
}

/** 仅桥接原生历史按钮和后台提交。原生 ChatView 继续渲染会话并处理主动跳转。 */
export function useHistoryViewport(session) {
  const scope = useRef(null)
  useLayoutEffect(() => session?.attachHistoryView({
    prepend: (publish, options) => preserveHistoryPrepend(scope.current, publish, options),
  }), [session])

  function onClickCapture(event) {
    const button = event.target.closest?.('[data-chat-history] button')
    const view = scope.current
    if (!view || !button || button.disabled || button.closest(occurrence) !== view) return
    // 流式读取会接管这次点击。偏好尚未加载时让原生按钮沿用自己的分页行为。
    if (session.startEarlier() === true) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  return { ref: scope, onClickCapture }
}
