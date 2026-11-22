import { Button, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { codexSubagentActivity } from '../native-chat/subagent-activity.js'

const slot = 'conversation.chat.node'
const locale = 'codex.subagent.activity'
const labels = {
  zh: { started: '已启动子智能体', completed: '子智能体已完成', interrupted: '子智能体已中断', unavailable: '无法打开子会话' },
  en: { started: 'Started subagent', completed: 'Subagent completed', interrupted: 'Subagent interrupted', unavailable: 'Unable to open subagent conversation' },
}
const iconSize = 'calc(16px + var(--dsh-content-font-delta, 0px))'
const rowStyle = {
  display: 'flex', alignItems: 'center', columnGap: '6px', minWidth: 0,
  font: 'var(--dsw-font-markdown-base)',
  color: 'var(--dsw-alias-label-tertiary)',
}
const iconStyle = { display: 'inline-grid', placeItems: 'center', flex: 'none', width: iconSize, height: iconSize }
const sentenceStyle = { minWidth: 0, overflowWrap: 'anywhere' }
// 同 DSH 正文的行内代码共享文本基线，点击控件继承代码的排版。
const codeStyle = {
  display: 'inline-flex', alignItems: 'center', maxWidth: '100%', boxSizing: 'border-box', padding: '0 5px',
  font: 'var(--dsw-font-markdown-code)', fontFamily: 'var(--ds-font-family-code)', fontSize: '0.875em',
  backgroundColor: 'var(--dsw-alias-markdown-inline-code)',
  border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-sm)',
  color: 'var(--dsw-alias-label-secondary)',
}
const pathButtonStyle = {
  display: 'block', height: 'auto', minWidth: 0, padding: 0,
  background: 'none', font: 'inherit', color: 'inherit', textAlign: 'start', overflowWrap: 'inherit',
}

function SubagentActivity({ node, open, t }) {
  const { kind, agentThreadId, agentPath } = node.data
  const pending = useRef(null)
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => () => pending.current?.abort(), [])

  async function openChild() {
    if (pending.current) return
    const request = new AbortController()
    pending.current = request
    setBusy(true)
    setUnavailable(false)
    try {
      if (!await open(agentThreadId, request.signal) && !request.signal.aborted) setUnavailable(true)
    } catch {
      if (!request.signal.aborted) setUnavailable(true)
    } finally {
      pending.current = null
      if (!request.signal.aborted) setBusy(false)
    }
  }

  return <div style={rowStyle}>
    <span style={iconStyle} aria-hidden><IconUsersOutlineRegular size={16} /></span>
    <div style={sentenceStyle}>
      {t(kind)}{' '}
      <code style={codeStyle}>{agentThreadId
        ? <Button size="sm" onClick={openChild} disabled={busy} style={pathButtonStyle}>{agentPath}</Button>
        : agentPath}</code>
      {unavailable && <> <span role="status">{t('unavailable')}</span></>}
    </div>
  </div>
}

/** 使用 DSH 聊天的节点注册和子会话导航处理原生 Codex 活动。 */
export function installSubagentActivity(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['uiConversation'], scope => scope.uiConversation.events.register(codexSubagentActivity))
  ctx.inject(['uiWorkspace'], scope => {
    scope.slots.inject(slot, () => scope.slots.register({
      name: slot, key: codexSubagentActivity.kind, id: codexSubagentActivity.kind, locale,
      inject: () => ({
        async open(threadId, signal) {
          const target = await catalog.resolveSubagent(threadId, signal)
          if (!target || signal.aborted) return false
          scope.uiWorkspace.openSession(target)
          return true
        },
      }),
    }, SubagentActivity))
  })
}
