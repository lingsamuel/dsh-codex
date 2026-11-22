import { Button, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { codexSubagentActivity } from '../native-chat/subagent-activity.js'

const slot = 'conversation.chat.node'
const locale = 'codex.subagent.activity'
const labels = {
  zh: { started: '已启动子智能体', completed: '子智能体已完成', interrupted: '子智能体已中断', unavailable: '无法打开子会话' },
  en: { started: 'Started subagent', completed: 'Subagent completed', interrupted: 'Subagent interrupted', unavailable: 'Unable to open subagent conversation' },
}
const rowStyle = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem',
  fontSize: '0.875rem', color: 'var(--dsw-alias-label-secondary)',
}
const pathStyle = { whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start' }

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
    <IconUsersOutlineRegular size={16} aria-hidden />
    <span>{t(kind)}</span>
    {agentThreadId
      ? <Button size="sm" variant="ghost" onClick={openChild} disabled={busy} style={pathStyle}><code>{agentPath}</code></Button>
      : <code>{agentPath}</code>}
    {unavailable && <span role="status">{t('unavailable')}</span>}
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
