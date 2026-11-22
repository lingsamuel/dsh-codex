import { readPage, writeCommandAction, writeConversationAction } from '../api.js'
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
export function createSessionInput(ctx, threadId, history, modelDraft, permissionDraft, worktreeDraft, openWorktree, goalDraft) {
  const { session, events, queueStore, updateState, activeTurnId } = history
  const submissions = new Map()
  let goalConfirmation

  function clearDrafts(model, permission) {
    modelDraft.clear(model)
    permissionDraft?.clear(permission)
  }

  function permissionSnapshot(profileId) {
    return profileId && session.projections.faceOf('permissions').getSnapshot()
  }

  function confirmPermission(profileId, before, result) {
    if (!result?.permission) return
    const current = permissionSnapshot(profileId)
    // 恢复期间重连可能先读到旧历史，只有更新的运行时确认可以取代本次响应。
    if (current === before || current?.permission?.source !== 'runtime') session.publishPermission(result.permission)
  }

  function acceptSubmittedSettings(model, profileId, before, result) {
    confirmPermission(profileId, before, result)
    clearDrafts(model, profileId)
  }

  function retire(requestId, settlement) {
    const submission = submissions.get(requestId)
    if (!submission) return
    submissions.delete(requestId)
    if (settlement.reason === 'observed') {
      // 待发项可能先于 HTTP 回执被领取。保留已送达状态，再交接原生草稿图片。
      submission.observed = true
      clearDrafts(submission.model, submission.permission)
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
      goalConfirmation?.resolve(false)
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

  /** 确认绑定提交时读到的原生目标。取消交给 DSH 恢复同一份输入草稿。 */
  async function confirmGoalReplacement(goal, signal) {
    signal?.throwIfAborted()
    const confirmation = Promise.withResolvers()
    goalConfirmation = confirmation
    const cancel = () => confirmation.resolve(false)
    signal?.addEventListener('abort', cancel, { once: true })
    updateState(state => { state.goalReplacement = { objective: goal.objective, createdAt: goal.createdAt } })
    try {
      return await confirmation.promise
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (goalConfirmation === confirmation) {
        goalConfirmation = undefined
        updateState(state => { state.goalReplacement = undefined })
      }
    }
  }

  async function submitGoal(content, goalDraftValue, worktree, selection, profileId, before, unarchive, signal, requestId) {
    if (session.getSnapshot().planChanging) throw new Error('正在切换计划模式，请等待 Codex 确认后再提交。')
    if (content.some(part => part.type !== 'text') || worktree) {
      throw new Error('目标使用输入栏正文。请移除附件和待创建的工作树，或退出 Goal 模式后按普通消息发送。')
    }
    const objective = userInputText(content).trim()
    if (!objective) throw new Error('请输入目标内容。')
    const tokenBudget = goalDraftValue.budget ? Number(goalDraftValue.budget) : undefined
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new Error('Token 预算必须是正整数。')
    const command = (action, fields) => writeCommandAction({ threadId, action, ...fields, ...(unarchive && { unarchive: true }) }, signal)
    if (session.getSnapshot().planMode === 'plan') {
      const { planRevision } = session.getSnapshot()
      const result = await command('plan', { mode: 'default' })
      if (!result.confirmed) throw new Error('Codex 尚未确认退出计划模式。请确认后再提交目标。')
      session.publishPlanMode(result.mode, planRevision)
    }
    const info = await readPage('thread-info', { threadId, view: 'goal' }, signal)
    if (info.goalAvailable === false) throw new Error('当前 Codex 会话无法创建目标。')
    const { goal } = info.goalRequiresUnarchive && unarchive ? await command('goal-unarchive') : info
    if (goal && !await confirmGoalReplacement(goal, signal)) {
      retire(requestId, failedSubmission)
      return failure(new Error('目标创建已取消。'))
    }
    const { goalRevision } = session.getSnapshot()
    const result = await command('goal-create', { objective, tokenBudget, modelDraft: selection, permissionDraft: profileId,
      ...(goal && { expectedGoal: { objective: goal.objective, createdAt: goal.createdAt } }) })
    session.publishGoal(result.goal, goalRevision)
    acceptSubmittedSettings(selection, profileId, before, result)
    goalDraft.clear(goalDraftValue)
    retire(requestId, observedSubmission)
    return accepted
  }

  async function control(action, parameters, op, onAccepted) {
    updateState(state => { state.promptError = null })
    try {
      const result = await native(action, parameters)
      onAccepted?.(result)
      return accepted
    } catch (error) {
      return operationFailure(op, error)
    }
  }

  return {
    acceptSubmittedSettings,
    decideGoalReplacement: accepted => goalConfirmation?.resolve(accepted),
    beginSubmission({ mode, text, attachments, onAccept, onRetire }) {
      const { running, archived, blank } = session.getSnapshot()
      const worktree = blank && !archived ? worktreeDraft?.getSnapshot() : undefined
      const goal = goalDraft?.getSnapshot()
      const requestId = (!goal && worktree?.id) || crypto.randomUUID()
      const expectedTurnId = mode === 'steer' ? activeTurnId() : undefined
      const placement = expectedTurnId ? 'steering'
        : running || queueStore.getSnapshot().length ? 'queued' : 'transcript'
      // DSH 发送前会等编辑器完成回显。插话仍需指向用户按键时看到的原生轮次。
      submissions.set(requestId, { onAccept, onRetire, expectedTurnId, worktree, goal,
        model: modelDraft.getSnapshot(), permission: permissionDraft?.getSnapshot(), unarchive: archived })
      updateState(state => {
        if (!goal) state.pendingSubmissions.push({ requestId, placement, time: Date.now(), text, attachments })
        state.promptAttempted = true
      })
      return { requestId, abandon: () => retire(requestId, failedSubmission) }
    },
    async prompt(content, mode, signal, requestId = crypto.randomUUID()) {
      const submission = submissions.get(requestId)
      const worktree = submission?.worktree
      const { kind, id, path, baseRef } = worktree ?? {}
      const expectedTurnId = submission ? submission.expectedTurnId : mode === 'steer' ? activeTurnId() : undefined
      const selection = submission ? submission.model : modelDraft.getSnapshot()
      const profileId = submission ? submission.permission : permissionDraft?.getSnapshot()
      const before = permissionSnapshot(profileId)
      const unarchive = submission ? submission.unarchive : session.getSnapshot().archived
      const goal = submission ? submission.goal : goalDraft?.getSnapshot()
      updateState(state => {
        state.promptError = null
        state.lastAgentError = null
        state.promptAttempted = true
      })
      try {
        if (goal) return await submitGoal(content, goal, worktree, selection, profileId, before, unarchive, signal, requestId)
        const input = content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text, text_elements: [] }
          if (part.type === 'image') return { type: 'image', url: `data:${part.mediaType};base64,${part.data}` }
          throw new Error('当前仅支持发送文本和图片。')
        })
        const result = await native('prompt', { input, mode: expectedTurnId ? 'steer' : 'queue', clientUserMessageId: requestId,
          expectedTurnId, modelDraft: selection, permissionDraft: profileId,
          ...(worktree && { worktree: { kind, id, path, baseRef } }),
          ...(unarchive && { unarchive: true }) }, signal)
        if (worktree && result.thread) {
          // 原生目标是新会话。先让 DSH 清除已送达的原草稿，再切换显示会话。
          worktreeDraft.clear(worktree)
          retire(requestId, observedSubmission)
          openWorktree(result)
        } else acceptSubmittedSettings(selection, profileId, before, result)
        return accepted
      } catch (error) {
        // 如果回显已被原生历史或队列确认，网络错误也不应恢复草稿造成重复发送。
        if (submission?.observed) return accepted
        const settlement = observedSettlement(requestId)
        if (settlement) {
          clearDrafts(selection, profileId)
          retire(requestId, settlement)
          return accepted
        }
        retire(requestId, failedSubmission)
        if (worktree && error.worktreeRecovery && worktreeDraft.getSnapshot() === worktree) {
          worktreeDraft.set({ ...worktree, recovery: error.worktreeRecovery })
        }
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
    async viewQueue() {
      try {
        const accept = history.captureQueueView()
        const { data } = await native('queue', { operation: 'list', unarchive: true })
        await accept(data)
        return { ok: true, value: { empty: queueStore.getSnapshot().length === 0 } }
      } catch (error) {
        return failure(error)
      }
    },
    startQueue() {
      const model = modelDraft.getSnapshot()
      const profileId = permissionDraft?.getSnapshot()
      const before = permissionSnapshot(profileId)
      return control('queue', { operation: 'start', modelDraft: model, permissionDraft: profileId,
        ...(session.getSnapshot().archived && { unarchive: true }) }, 'send', result => {
        if (result?.queueEmpty) return
        acceptSubmittedSettings(model, profileId, before, result)
      })
    },
  }
}
