import { IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { describeLiveStatus, installUnreadStatus, publishPendingStatus } from './live-status.js'

const header = 'conversation.session.header.utilities'
const dock = 'conversation.input.dock'
const locale = 'codex.session.status'
const dictionaries = {
  zh: {
    'mode.connecting': '连接 Codex…',
    'mode.history': 'Codex 历史',
    reconnecting: 'Codex 实时同步中断，正在重连…',
    'activity.failed': '上一轮失败',
    'activity.systemError': '会话异常',
  },
  en: {
    'mode.connecting': 'Connecting to Codex…',
    'mode.history': 'Codex history',
    reconnecting: 'Codex live sync interrupted. Reconnecting…',
    'activity.failed': 'Last turn failed',
    'activity.systemError': 'Session error',
  },
}

const styles = `
  .codex-sync-notice {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
    border-radius: var(--dsw-radius-md);
    background: var(--dsw-alias-state-warn-tertiary);
    color: var(--dsw-alias-label-primary);
    font-size: 13px;
    line-height: 20px;
  }
  .codex-sync-notice svg {
    flex: none;
    margin-top: 2px;
    color: var(--dsw-alias-state-warn-primary);
  }
`

function SessionLiveStatus({ useSession, t }) {
  const live = useSession(state => state.live)
  const { mode, activity } = describeLiveStatus(live)
  const labels = []
  if (mode) labels.push(t(`mode.${mode}`))
  if (activity) labels.push(t(`activity.${activity}`))
  return labels.length ? <span role="status">{labels.join(' · ')}</span> : null
}

function ReconnectNotice({ useSession, t }) {
  const reconnecting = useSession(state => state.live?.reconnecting)
  if (!reconnecting) return null
  return <div className="codex-sync-notice" role="status">
    <IconWarningOutlineRegular aria-hidden="true" size={16} />
    <span>{t('reconnecting')}</span>
  </div>
}

/** 沿用 DSH 的侧栏状态和输入区插槽，重连提示随当前会话显示。 */
export function installLiveStatus(ctx, catalog) {
  ctx.inject(['uiSession', 'uiSession.sessionStatus'], scope => {
    scope.effect(() => installUnreadStatus(scope.uiSession.sessionStatus, catalog))
    const publish = scope.uiSession.registerPendingInteraction(() => 0)
    scope.effect(() => publishPendingStatus(catalog, publish))
  })
  ctx.effect(() => ctx.locale.register(locale, dictionaries))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  })
  ctx.slots.inject(header, () => ctx.slots.register(
    { name: header, id: 'codex-live-status', order: 10, locale },
    SessionLiveStatus,
  ))
  ctx.slots.inject(dock, () => ctx.slots.register(
    { name: dock, id: 'codex-reconnect-notice', order: -100, locale },
    ReconnectNotice,
  ))
}
