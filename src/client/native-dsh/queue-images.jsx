import { QueueDock } from '@deepseek-ai/dsh-client-ui-conversation/src/client/queue/QueueDock.tsx'
import { useMemo } from 'react'
import { QueueSteerDock } from './queue-steer.jsx'
import { FileDownloads } from './file-downloads.jsx'
import { allowsDirectInput } from './subagents.js'
import { adaptSlot } from './slot-adapter.js'

const dock = 'conversation.input.dock'
const locale = 'codex.queue.images'
const readOnlyQueue = { address: { mode: 'unknown' } }
const copy = {
  zh: { downloadFile: '下载 {name}',
    steering: '插话中', unconfirmed: '投递待确认', recoverable: '未送达，可恢复',
    check: '核对投递', restore: '恢复入队', download: '下载原稿',
    checkFailed: '暂时无法核对投递状态', restoreFailed: '暂时无法恢复待发消息' },
  en: { downloadFile: 'Download {name}',
    steering: 'Steering…', unconfirmed: 'Delivery unconfirmed', recoverable: 'Undelivered, ready to restore',
    check: 'Check delivery', restore: 'Restore to queue', download: 'Download original',
    checkFailed: 'Could not check delivery', restoreFailed: 'Could not restore the queued message' },
}

function CodexQueue({ native: Native, labels, ...props }) {
  const pending = props.useSession(state => state.pendingSubmissions)
  const inbox = props.useProjection('inbox')
  const files = inbox?.['next-turn']?.flatMap(row =>
    row.content.filter(part => part.type === 'file').map(part => part.attachment)) ?? []
  // 原生队列用 transcript 身份去重。插话回落和已被历史接手的身份也继续过滤旧队列行。
  const chatEchoes = useMemo(() => pending.map(item => item.placement === 'steering' || item.awaitingQueueClear
    ? { ...item, placement: 'transcript' } : item), [pending])
  // DSH 的队列组件通过会话地址判断只读状态。此映射只传给队列组件。
  function useQueueSession(select) {
    return props.useSession(state => select({ ...state, pendingSubmissions: chatEchoes,
      ...((state.archived || !allowsDirectInput(state)) && { subagent: readOnlyQueue }) }))
  }
  const dockProps = { ...props, useSession: useQueueSession }
  return <>
    <QueueDock {...dockProps} />
    <QueueSteerDock Dock={Native} dockProps={dockProps} t={labels} />
    <FileDownloads files={files} label={name => labels('downloadFile', { name })} />
  </>
}

/** Codex 队列沿用 DSH 的行内编辑。附件正文保存仍由会话控制器处理。 */
export function installQueueImages(ctx) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  const t = ctx.locale.bind(locale)
  ctx.inject(['sessions'], scope => adaptSlot(scope, dock, entry => entry.options.id === 'queue',
    (inject, Native) => ({
      inject(sessionId, ...args) {
        const props = inject(sessionId, ...args)
        const session = scope.sessions.binding(sessionId)?.session
        if (!session?.queuedImageUrl) return props
        return { ...props, codexQueue: true, async loadImage(attachment) {
          return session.queuedImageUrl(attachment.attachmentId) ?? props.loadImage(attachment)
        } }
      },
      component: ({ codexQueue, ...props }) => codexQueue
        ? <CodexQueue {...props} native={Native} labels={t} />
        : <Native {...props} />,
    })))
}
