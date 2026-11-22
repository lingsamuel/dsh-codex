import { writeConversationAction } from '../api.js'
import { remoteFailure } from './catalog.js'
import { userInputText } from '../../shared/user-input.js'

const accepted = { ok: true, value: { accepted: true } }
const failedSubmission = { reason: 'failed' }
const observedSubmission = { reason: 'observed', attachments: [] }

function failure(error) {
  const detail = remoteFailure(error.message)
  if (error.reason) detail.code = `session/${error.reason}`
  return { ok: false, error: detail }
}

/** DSH 决定发送模式和草稿恢复，原生历史或队列确认送达后移除本地回显。 */
export function createSessionInput(ctx, threadId, history, modelDraft) {
  const { session, events, queueStore, updateState, activeTurnId } = history
  const submissions = new Map()

  function retire(requestId, settlement) {
    const submission = submissions.get(requestId)
    if (!submission) return
    submissions.delete(requestId)
    if (settlement.reason === 'observed') {
      // 待发项可能先于 HTTP 回执被领取。保留已送达状态，再交接原生草稿图片。
      submission.observed = true
      modelDraft.clear(submission.model)
      submission.onAccept?.()
    }
    updateState(state => {
      state.pendingSubmissions = state.pendingSubmissions.filter(item => item.requestId !== requestId)
    })
    submission.onRetire?.(settlement)
  }

  function observedSettlement(requestId) {
    const echo = events.getSnapshot().entries.find(({ event }) => event.type === 'user/message' && event.data.source.rpcId === requestId)
    if (echo) return { reason: 'observed', attachments: echo.event.data.content.flatMap(part => part.type === 'image' ? [part.attachment] : []) }
    if (queueStore.getSnapshot().some(item => item.clientUserMessageId === requestId)) return observedSubmission
  }

  function observeSubmissions() {
    for (const requestId of submissions.keys()) {
      const settlement = observedSettlement(requestId)
      if (settlement) retire(requestId, settlement)
    }
  }

  ctx.effect(() => {
    const stopEvents = events.subscribe(observeSubmissions)
    const stopQueue = queueStore.subscribe(observeSubmissions)
    return () => {
      stopEvents()
      stopQueue()
      for (const requestId of submissions.keys()) retire(requestId, failedSubmission)
    }
  })

  function native(action, parameters, signal) {
    return writeConversationAction({ threadId, action, ...parameters }, signal)
  }

  function operationFailure(op, error) {
    const result = failure(error)
    updateState(state => { state.promptError = { op, error: result.error } })
    return result
  }

  async function control(action, parameters, op) {
    updateState(state => { state.promptError = null })
    try {
      await native(action, parameters)
      return accepted
    } catch (error) {
      return operationFailure(op, error)
    }
  }

  return {
    beginSubmission({ mode, text, attachments, onAccept, onRetire }) {
      const requestId = crypto.randomUUID()
      const { running, archived } = session.getSnapshot()
      const placement = running && mode === 'steer' ? 'steering'
        : running || queueStore.getSnapshot().length ? 'queued' : 'transcript'
      // DSH 发送前会等编辑器完成回显。插话仍需指向用户按键时看到的原生轮次。
      submissions.set(requestId, { onAccept, onRetire, expectedTurnId: mode === 'steer' ? activeTurnId() : undefined,
        model: modelDraft.getSnapshot(), unarchive: archived })
      updateState(state => {
        state.pendingSubmissions.push({ requestId, placement, time: Date.now(), text, attachments })
        state.promptAttempted = true
      })
      return { requestId, abandon: () => retire(requestId, failedSubmission) }
    },
    async prompt(content, mode, signal, requestId = crypto.randomUUID()) {
      const submission = submissions.get(requestId)
      const expectedTurnId = submission ? submission.expectedTurnId : mode === 'steer' ? activeTurnId() : undefined
      const selection = submission ? submission.model : modelDraft.getSnapshot()
      const unarchive = submission ? submission.unarchive : session.getSnapshot().archived
      updateState(state => {
        state.promptError = null
        state.lastAgentError = null
        state.promptAttempted = true
      })
      try {
        const input = content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text, text_elements: [] }
          if (part.type === 'image') return { type: 'image', url: `data:${part.mediaType};base64,${part.data}` }
          throw new Error('当前仅支持发送文本和图片。')
        })
        await native('prompt', { input, mode, clientUserMessageId: requestId, expectedTurnId, modelDraft: selection,
          ...(unarchive && { unarchive: true }) }, signal)
        modelDraft.clear(selection)
        return accepted
      } catch (error) {
        // 如果回显已被原生历史或队列确认，网络错误也不应恢复草稿造成重复发送。
        if (submission?.observed) return accepted
        const settlement = observedSettlement(requestId)
        if (settlement) {
          modelDraft.clear(selection)
          retire(requestId, settlement)
          return accepted
        }
        retire(requestId, failedSubmission)
        return operationFailure('send', error)
      }
    },
    cancel() {
      return control('cancel', { turnId: activeTurnId() }, 'stop')
    },
    async updateQueue(queuedSubmissionId, action) {
      const { kind } = action
      const options = kind === 'edit' ? { text: userInputText(action.content) }
        : kind === 'steer' ? { expectedTurnId: activeTurnId() } : {}
      try {
        await native('queue', { queuedSubmissionId, operation: kind, ...options })
        return accepted
      } catch (error) {
        return failure(error)
      }
    },
    startQueue() {
      return control('queue', { operation: 'start', ...(session.getSnapshot().archived && { unarchive: true }) }, 'send')
    },
  }
}
