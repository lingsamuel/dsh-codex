import { describeLiveStatus } from './live-status.js'

const slot = 'conversation.session.header.utilities'
const locale = 'codex.session.status'
const dictionaries = {
  zh: {
    'mode.connecting': '连接 Codex…',
    'mode.live': 'Codex 实时跟随记录',
    'mode.history': 'Codex 历史',
    'mode.disconnected': 'Codex 连接断开',
    'activity.running': '运行中',
    'activity.idle': '空闲',
    'activity.waitingForApproval': '等待审批',
    'activity.waitingForAnswer': '等待回复',
    'activity.waitingForApprovalAndAnswer': '等待审批和回复',
    'activity.completed': '上一轮已完成',
    'activity.failed': '上一轮失败',
    'activity.interrupted': '上一轮已中断',
    'activity.systemError': '会话异常',
  },
  en: {
    'mode.connecting': 'Connecting to Codex…',
    'mode.live': 'Codex live record updates',
    'mode.history': 'Codex history',
    'mode.disconnected': 'Codex disconnected',
    'activity.running': 'Running',
    'activity.idle': 'Idle',
    'activity.waitingForApproval': 'Awaiting approval',
    'activity.waitingForAnswer': 'Awaiting reply',
    'activity.waitingForApprovalAndAnswer': 'Awaiting approval and reply',
    'activity.completed': 'Last turn completed',
    'activity.failed': 'Last turn failed',
    'activity.interrupted': 'Last turn interrupted',
    'activity.systemError': 'Session error',
  },
}

const statusStyle = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  whiteSpace: 'nowrap',
}

function SessionLiveStatus({ useSession, t }) {
  const live = useSession(state => state.live)
  const { mode, activity } = describeLiveStatus(live)
  const labels = [t(`mode.${mode}`)]
  if (activity) labels.push(t(`activity.${activity}`))
  const text = labels.join(' · ')
  return <span role="status" title={text} style={statusStyle}>{text}</span>
}

/** 在 DSH 会话标题栏显示只读连接与运行状态。 */
export function installLiveStatus(ctx) {
  ctx.effect(() => ctx.locale.register(locale, dictionaries))
  ctx.slots.inject(slot, () => ctx.slots.register(
    { name: slot, id: 'codex-live-status', order: 10, locale },
    SessionLiveStatus,
  ))
}
