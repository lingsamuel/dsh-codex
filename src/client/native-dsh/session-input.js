import { writeConversationAction } from '../api.js'
import { remoteFailure } from './catalog.js'

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
    updateState(state => {
      state.pendingSubmissions = state.pendingSubmissions.filter(item => item.requestId !== requestId)
    })
    submission.onRetire?.(settlement)
  }

  function submissionObserved(requestId) {
    return queueStore.getSnapshot().some(item => item.clientUserMessageId === requestId)
      || events.getSnapshot().entries.some(({ event }) => event.type === 'user/message' && event.data.source.rpcId === requestId)
  }

  function observeSubmissions() {
    for (const requestId of submissions.keys()) {
      if (submissionObserved(requestId)) retire(requestId, observedSubmission)
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
    beginSubmission({ mode, text, attachments, onRetire }) {
      const requestId = crypto.randomUUID()
      const { running } = session.getSnapshot()
      const placement = running && mode === 'steer' ? 'steering'
        : running || queueStore.getSnapshot().length ? 'queued' : 'transcript'
      // DSH 发送前会等编辑器完成回显。插话仍需指向用户按键时看到的原生轮次。
      submissions.set(requestId, { onRetire, expectedTurnId: mode === 'steer' ? activeTurnId() : undefined,
        model: modelDraft.getSnapshot() })
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
      updateState(state => {
        state.promptError = null
        state.lastAgentError = null
        state.promptAttempted = true
      })
      try {
        if (content.some(part => part.type !== 'text')) throw new Error('当前仅支持发送文本消息。')
        const input = content.map(({ text }) => ({ type: 'text', text, text_elements: [] }))
        await native('prompt', { input, mode, clientUserMessageId: requestId, expectedTurnId, modelDraft: selection }, signal)
        modelDraft.clear(selection)
        return accepted
      } catch (error) {
        // 如果回显已被原生历史或队列确认，网络错误也不应恢复草稿造成重复发送。
        if (submissionObserved(requestId)) {
          modelDraft.clear(selection)
          retire(requestId, observedSubmission)
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
      const options = kind === 'edit' ? { text: action.content.map(part => part.text).join('') }
        : kind === 'steer' ? { expectedTurnId: activeTurnId() } : {}
      try {
        await native('queue', { queuedSubmissionId, operation: kind, ...options })
        return accepted
      } catch (error) {
        return failure(error)
      }
    },
    startQueue() {
      return control('queue', { operation: 'start' }, 'send')
    },
  }
}
