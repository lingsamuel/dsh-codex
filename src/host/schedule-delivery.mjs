import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { withBlankDraft } from './catalog.mjs'
import { startOnlyQueuedMessage } from './conversation-actions.mjs'
import { explicitlyRejected } from './first-submission.mjs'
import { readLatestTurn } from './live-history.mjs'
import { addressableThread, findThreadSubmission, isArchived, readConversationQueue, resumeThread, waitForThreadActivity } from './thread-runtime.mjs'

/** 把 Schedule 的投递边界接到共享 App Server。确认目标时只读，实际投递才恢复线程。 */
export function createScheduleDelivery(submit, ownerSignal, connect = (signal, work) =>
  withCodexReader(process.env.DSH_CODEX_SOCKET, signal, work)) {
  const lifetime = signal => signal ? AbortSignal.any([ownerSignal, signal]) : ownerSignal

  async function target(request, threadId) {
    const thread = await addressableThread(request, threadId)
    if (withBlankDraft(thread).blank) {
      throw new CodexRpcError({ code: -32602, message: '空白草稿无法接收定时任务。' })
    }
    if (await isArchived(request, threadId)) {
      throw new CodexRpcError({ code: -32602, message: '已归档的会话无法接收定时任务。' })
    }
    return thread
  }

  async function send(threadId, text, pending, recover, save, signal) {
    const active = AbortSignal.any([lifetime(signal), AbortSignal.timeout(15_000)])
    return submit(threadId, () => connect(active, async request => {
      const thread = await target(request, threadId)
      let queuedSubmission
      if (recover) {
        // 原生队列允许相同客户端标识。写入不明确时只能从原生记录确认。
        const receipt = await findThreadSubmission(request, threadId, pending.messageId)
        if (receipt?.turn) return new Date().toISOString()
        queuedSubmission = receipt?.queuedSubmission
        if (!queuedSubmission) throw new Error('Codex 尚未确认这次定时投递。')
      } else {
        await resumeThread(request, thread)
        active.throwIfAborted()
        await save(pending)
        if (active.aborted) {
          await save(undefined)
          active.throwIfAborted()
        }
        const result = await request('thread/queue/add', {
          threadId,
          clientUserMessageId: pending.messageId,
          input: [{ type: 'text', text, text_elements: [] }],
        }).catch(async error => {
          if (explicitlyRejected(error)) await save(undefined)
          throw error
        })
        queuedSubmission = result.queuedSubmission
        if (!queuedSubmission?.id) throw new Error('Codex 未返回定时投递的队列回执。')
      }
      if (recover) await resumeThread(request, thread)
      const deliveredAt = new Date().toISOString()
      const { started } = await startOnlyQueuedMessage(request, threadId, queuedSubmission.id)
      if (started || thread.status?.type === 'notLoaded') await waitForThreadActivity(request, threadId, active)
      return deliveredAt
    }))
  }

  async function outstanding(threadId, messageId) {
    return connect(ownerSignal, async request => {
      const { thread } = await request('thread/read', { threadId })
      if (thread.archived) return false
      const queue = await readConversationQueue(request, threadId)
      if (queue.some(item => item.clientUserMessageId === messageId)) return true
      if (thread.status?.type !== 'active') return false
      const turn = await readLatestTurn(request, threadId, 'full')
      return turn?.status === 'inProgress' && turn.items?.some(item => item.type === 'userMessage' && item.clientId === messageId) === true
    })
  }

  return { send, outstanding, validate: (threadId, signal) => connect(lifetime(signal), request => target(request, threadId)) }
}
