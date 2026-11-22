import { describeLiveStatus, installUnreadStatus, publishPendingStatus } from './live-status.js'

const slot = 'conversation.session.header.utilities'
const locale = 'codex.session.status'
const dictionaries = {
  zh: {
    'mode.connecting': '连接 Codex…',
    'mode.history': 'Codex 历史',
    'mode.disconnected': 'Codex 连接断开',
    'activity.failed': '上一轮失败',
    'activity.interrupted': '上一轮已中断',
    'activity.systemError': '会话异常',
  },
  en: {
    'mode.connecting': 'Connecting to Codex…',
    'mode.history': 'Codex history',
    'mode.disconnected': 'Codex disconnected',
    'activity.failed': 'Last turn failed',
    'activity.interrupted': 'Last turn interrupted',
    'activity.systemError': 'Session error',
  },
}

function SessionLiveStatus({ useSession, t }) {
  const live = useSession(state => state.live)
  const { mode, activity } = describeLiveStatus(live)
  const labels = []
  if (mode) labels.push(t(`mode.${mode}`))
  if (activity) labels.push(t(`activity.${activity}`))
  return labels.length ? <span role="status">{labels.join(' · ')}</span> : null
}

/** 沿用 DSH 侧栏状态，标题栏补充连接与异常信息。 */
export function installLiveStatus(ctx, catalog) {
  ctx.inject(['uiSession'], scope => {
    scope.effect(() => installUnreadStatus(scope.uiSession.sessionStatus, catalog))
    const publish = scope.uiSession.registerPendingInteraction(() => 0)
    scope.effect(() => publishPendingStatus(catalog, publish))
  })
  ctx.effect(() => ctx.locale.register(locale, dictionaries))
  ctx.slots.inject(slot, () => ctx.slots.register(
    { name: slot, id: 'codex-live-status', order: 10, locale },
    SessionLiveStatus,
  ))
}
