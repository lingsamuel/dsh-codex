import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { readPage, writeCommandAction, writeConversationAction } from '../api.js'
import { remoteFailure } from './catalog.js'
import { goalCommandObjective, planCommandText, replaceUserInputText, userInputText } from '../../shared/user-input.js'
import { threadReferencesIn } from '../../shared/thread-references.js'

const accepted = { ok: true, value: { accepted: true } }
const failedSubmission = { reason: 'failed' }
const observedSubmission = { reason: 'observed', attachments: [] }

function failure(error) {
  const detail = remoteFailure(error.message)
  if (error.reason) detail.code = `session/${error.reason}`
  return { ok: false, error: detail }
}

function worktreeSelection(worktree) {
  if (!worktree) return
  const { kind, id, path, baseRef } = worktree
  return { kind, id, path, baseRef }
}

/** 使用 DSH 输入栏的提交生命周期，原生历史或队列确认送达后移除本地回显。 */
export function createSessionInput(ctx, threadId, history, modelDraft, permissionDraft, worktreeDraft, openWorktree, goalDraft, newSession, reviewSubmissionId) {
  const { session, events, queueStore, updateState, activeTurnId } = history
  // 首发回执可能在刷新期间丢失。沿用已保存的草稿 ID，Host 才能找到原来的投递。
  const newSessionRequestId = newSession ? threadId : undefined
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

  function acceptSubmittedSettings(model, profileId, before, result, worktree) {
    confirmPermission(profileId, before, result)
    clearDrafts(model, profileId)
    if (worktree) worktreeDraft.clear(worktree)
  }

  function removeSubmission(requestId) {
    submissions.delete(requestId)
    updateState(state => {
      state.pendingSubmissions = state.pendingSubmissions.filter(item => item.requestId !== requestId)
    })
  }

  function acceptObserved(submission, consumeSettings = true) {
    if (submission.observed) return
    // 队列或历史可以先于 HTTP 回执确认接纳。此时编辑器即可交接草稿，气泡独立等待原生接手。
    submission.observed = true
    if (consumeSettings) clearDrafts(submission.model, submission.permission)
    submission.onAccept?.()
  }

  function retire(requestId, settlement, consumeSettings = true) {
    const submission = submissions.get(requestId)
    if (!submission) return
    if (settlement.reason === 'observed') acceptObserved(submission, consumeSettings)
    removeSubmission(requestId)
    submission.onRetire?.(settlement)
  }

  function historySettlement(requestId, entries) {
    const echo = entries.find(({ event }) => event.type === 'user/message' ? event.data.source.rpcId === requestId
      : event.type === 'tool/result' && event.data.meta?.codexQuestionReply && event.data.meta.clientUserMessageId === requestId)
    if (echo) return echo.event.type === 'user/message'
      ? { reason: 'observed', attachments: echo.event.data.content.flatMap(part => part.type === 'image' ? [part.attachment] : []) }
      : observedSubmission
  }

  function displayedEcho({ echo, awaitingQueueClear }) {
    return awaitingQueueClear ? { ...echo, placement: 'queued', awaitingQueueClear } : echo
  }

  function observeSubmission(requestId, submission, entries) {
    submission.settlement ??= historySettlement(requestId, entries)
    const index = queueStore.getSnapshot().findIndex(item => item.clientUserMessageId === requestId)
    if (!submission.settlement && index < 0) return false
    // 普通发送和插话回落都可能短暂占用队首。原生队列清空前继续屏蔽旧队列行。
    const keepInChat = submission.echo && submission.echo.placement !== 'queued' && index >= 0
      && (submission.settlement || (index === 0 && !submission.queuedForLater))
    if (keepInChat) {
      acceptObserved(submission)
      if (submission.settlement && !submission.awaitingQueueClear) {
        // 原生历史接手后仅保留队列去重身份，聊天区只显示正式消息。
        submission.awaitingQueueClear = true
        updateState(state => {
          state.pendingSubmissions = state.pendingSubmissions.map(item => item.requestId === requestId ? displayedEcho(submission) : item)
        })
      }
    } else retire(requestId, submission.settlement ?? observedSubmission)
    return true
  }

  function observeSubmissions(entries) {
    for (const [requestId, submission] of submissions) observeSubmission(requestId, submission, entries)
  }

  function trackSubmission(requestId, submission) {
    submissions.set(requestId, submission)
    updateState(state => {
      if (submission.echo) state.pendingSubmissions.push(submission.echo)
      state.promptAttempted = true
    })
    return { requestId, abandon: () => retire(requestId, failedSubmission) }
  }

  function confirmQueuedForLater(requestId, submission) {
    if (!submission || submissions.get(requestId) !== submission) return
    submission.queuedForLater = true
    observeSubmission(requestId, submission, [])
  }

  function openSubmittedThread(result, requestId) {
    if (session.getSnapshot().newSessionRecovery) updateState(state => { delete state.newSessionRecovery })
    const submission = submissions.get(requestId)
    if (!submission?.echo) {
      retire(requestId, observedSubmission, !newSession)
      return openWorktree(result)
    }
    acceptObserved(submission, !newSession)
    openWorktree(result, true, target => {
      if (submissions.get(requestId) !== submission) return
      if (!target) return retire(requestId, observedSubmission)
      removeSubmission(requestId)
      const nativeId = result.clientUserMessageId ?? result.queuedSubmission?.clientUserMessageId ?? requestId
      // DSH 的回调绑定草稿会话。目标历史从自己的附件引用加载，原回调只释放草稿预览。
      target.adoptSubmission({ ...submission.echo, requestId: nativeId }, () => submission.onRetire?.(observedSubmission), result.queuedForLater)
    })
  }

  ctx.effect(() => {
    const stopEvents = events.subscribe(() => {
      if (submissions.size) observeSubmissions(events.getSnapshot().change.entries)
    })
    const stopQueue = queueStore.subscribe(() => observeSubmissions([]))
    const stopGoal = goalDraft?.subscribe(() => {
      if (!goalDraft.getSnapshot() && session.getSnapshot().goalError) {
        updateState(state => { state.goalError = null })
      }
    })
    return () => {
      goalConfirmation?.resolve(false)
      stopEvents()
      stopQueue()
      stopGoal?.()
      for (const requestId of submissions.keys()) retire(requestId, failedSubmission)
    }
  })

  function native(action, parameters, signal) {
    return writeConversationAction({ threadId, action, ...parameters }, signal)
  }

  function initialPlanMode() {
    if (newSession && session.getSnapshot().planMode === 'plan') return 'plan'
  }

  function operationFailure(op, error) {
    const result = failure(error)
    updateState(state => { state.promptError = { op, error: result.error } })
    return result
  }

  function rememberNewSessionRecovery(error) {
    if (newSession && error.newSessionRecovery) {
      updateState(state => { state.newSessionRecovery = error.newSessionRecovery })
    }
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

  async function submitGoal(content, objective, goalDraftValue, worktree, selection, profileId, before, unarchive, signal, requestId) {
    if (session.getSnapshot().planChanging) throw new Error('正在切换计划模式，请等待 Codex 确认后再提交。')
    if (content.some(part => part.type !== 'text') || (worktree && !newSession)) {
      throw new Error('目标使用输入栏正文。请移除附件和待创建的工作树，或退出 Goal 模式后按普通消息发送。')
    }
    if (!objective) throw new Error('请输入目标内容。')
    if (threadReferencesIn(objective).length) {
      throw new Error('会话引用需要随消息提交。请退出 Goal 模式后继续发送。')
    }
    const tokenBudget = goalDraftValue?.budget ? Number(goalDraftValue.budget) : undefined
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new Error('Token 预算必须是正整数。')
    if (newSession) {
      const result = await writeCommandAction({ threadId, action: 'goal-create', objective, tokenBudget, newSession,
        clientUserMessageId: requestId, modelDraft: selection, permissionDraft: profileId, worktree: worktreeSelection(worktree) }, signal)
      acceptSubmittedSettings(selection, profileId, before, result, worktree)
      if (goalDraftValue) goalDraft.clear(goalDraftValue)
      openSubmittedThread(result, requestId)
      return accepted
    }
    const command = (action, fields) => writeCommandAction({ threadId, action, ...fields, ...(unarchive && { unarchive: true }) }, signal)
    if (session.getSnapshot().planMode === 'plan') {
      const result = await changePlanMode('default', unarchive, signal)
      if (!result.confirmed) throw new Error('Codex 尚未确认退出计划模式。请确认后再提交目标。')
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
    if (goalDraftValue) goalDraft.clear(goalDraftValue)
    retire(requestId, observedSubmission)
    return accepted
  }

  async function changePlanMode(mode, unarchive, signal) {
    const { planRevision } = session.getSnapshot()
    if (newSession) {
      session.publishPlanMode(mode, planRevision)
      return { mode, confirmed: true }
    }
    const result = await writeCommandAction({ threadId, action: 'plan', mode, ...(unarchive && { unarchive: true }) }, signal)
    if (result.confirmed) session.publishPlanMode(result.mode, planRevision)
    return result
  }

  async function togglePlan(content, unarchive, signal, requestId) {
    if (content.some(part => part.type !== 'text')) throw new Error('请填写计划任务后连同附件一起发送。')
    const mode = session.getSnapshot().planMode === 'plan' ? 'default' : 'plan'
    const draft = goalDraft?.getSnapshot()
    const result = await changePlanMode(mode, unarchive, signal)
    if (!result.confirmed) throw new Error('Codex 尚未确认计划模式。')
    if (mode === 'plan') goalDraft?.clear(draft)
    retire(requestId, observedSubmission, false)
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
    changePlanMode,
    /** 在切换会话时接续原气泡和附件所有权，并核对目标可能已加载的原生历史。 */
    adoptSubmission(echo, onRetire, queuedForLater) {
      const { requestId } = echo
      const submission = { echo, onRetire, observed: true, queuedForLater }
      submissions.set(requestId, submission)
      observeSubmission(requestId, submission, events.getSnapshot().entries)
      if (!submissions.has(requestId)) return
      updateState(state => {
        state.pendingSubmissions.push(displayedEcho(submission))
        state.promptAttempted = true
      })
    },
    ...(newSession && { async runCommand(parameters, signal) {
      const model = modelDraft.getSnapshot()
      const profileId = permissionDraft?.getSnapshot()
      const before = permissionSnapshot(profileId)
      const worktree = worktreeDraft?.getSnapshot()
      const clientUserMessageId = reviewSubmissionId()
      const result = await writeCommandAction({ ...parameters, threadId, newSession, clientUserMessageId,
        modelDraft: model, permissionDraft: profileId, worktree: worktreeSelection(worktree), planMode: initialPlanMode() }, signal).catch(error => {
        rememberNewSessionRecovery(error)
        throw error
      })
      reviewSubmissionId(clientUserMessageId)
      if (session.getSnapshot().newSessionRecovery?.thread.id === result.thread.id) {
        updateState(state => { delete state.newSessionRecovery })
      }
      acceptSubmittedSettings(model, profileId, before, result, worktree)
      // 审查表单单独提交，原生输入栏里的未发送内容继续留在原会话。
      openWorktree(result, true, undefined, parameters.action === 'review')
      return result
    } }),
    decideGoalReplacement: accepted => goalConfirmation?.resolve(accepted),
    dismissGoalError(error) {
      if (session.getSnapshot().goalError === error) updateState(state => { state.goalError = null })
    },
    /** 问答面板与输入栏共用气泡交接。答题不会消耗输入栏的模型或权限草稿。 */
    beginQuestionReply(turnId, text, realtime) {
      const requestId = randomUUID()
      const inTurn = realtime || Boolean(turnId && activeTurnId() === turnId)
      const placement = inTurn ? 'steering' : queueStore.getSnapshot().length ? 'queued' : 'transcript'
      const submission = { echo: { requestId, placement, time: Date.now(), text, attachments: [] } }
      return { ...trackSubmission(requestId, submission),
        queuedForLater: () => confirmQueuedForLater(requestId, submission),
        observed: () => submission.observed === true,
      }
    },
    beginSubmission({ mode, text, attachments, onAccept, onRetire }) {
      const { running, archived, blank } = session.getSnapshot()
      const worktree = blank && !archived ? worktreeDraft?.getSnapshot() : undefined
      const goal = goalDraft?.getSnapshot()
      const parts = [{ type: 'text', text }]
      const plan = planCommandText(parts)
      const isCommandOnly = plan === '' || (plan === undefined && Boolean(goal || goalCommandObjective(parts)))
      // 收不到首发回执时，重试仍用原来的身份核对投递结果。
      const requestId = (plan !== '' && newSessionRequestId) || (!isCommandOnly && worktree?.id) || randomUUID()
      const expectedTurnId = mode === 'steer' && plan === undefined ? activeTurnId() : undefined
      const placement = expectedTurnId ? 'steering'
        : running || queueStore.getSnapshot().length ? 'queued' : 'transcript'
      const echo = isCommandOnly ? undefined : { requestId, placement, time: Date.now(), text: plan ?? text, attachments }
      // DSH 发送前会等编辑器完成回显。插话仍需指向用户按键时看到的原生轮次。
      return trackSubmission(requestId, { echo, onAccept, onRetire, expectedTurnId, worktree, goal,
        model: modelDraft.getSnapshot(), permission: permissionDraft?.getSnapshot(), unarchive: archived })
    },
    async prompt(content, mode, signal, requestId = newSessionRequestId ?? randomUUID()) {
      const submission = submissions.get(requestId)
      const worktree = submission?.worktree
      const plan = planCommandText(content)
      const expectedTurnId = plan !== undefined ? undefined : submission ? submission.expectedTurnId : mode === 'steer' ? activeTurnId() : undefined
      const selection = submission ? submission.model : modelDraft.getSnapshot()
      const profileId = submission ? submission.permission : permissionDraft?.getSnapshot()
      const before = permissionSnapshot(profileId)
      const unarchive = submission ? submission.unarchive : session.getSnapshot().archived
      const draft = submission ? submission.goal : goalDraft?.getSnapshot()
      const goal = plan === undefined ? draft : undefined
      const objective = plan !== undefined ? undefined : goal ? userInputText(content).trim() : goalCommandObjective(content)
      updateState(state => {
        state.promptError = null
        state.goalError = null
        state.lastAgentError = null
        state.promptAttempted = true
      })
      try {
        if (plan === '') return await togglePlan(content, unarchive, signal, requestId)
        if (goal || objective) {
          return await submitGoal(content, objective, goal, worktree, selection, profileId, before, unarchive, signal, requestId)
        }
        const input = (plan === undefined ? content : replaceUserInputText(content, plan)).map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text, text_elements: [] }
          if (part.type === 'image') return { type: 'image', url: `data:${part.mediaType};base64,${part.data}` }
          if (part.type === 'file') return { type: 'file', receiptId: part.receiptId }
          throw new Error('消息包含不支持的附件。')
        })
        const { planRevision } = session.getSnapshot()
        const result = await native('prompt', { input, mode: expectedTurnId ? 'steer' : 'queue', clientUserMessageId: requestId,
          ...(submission?.echo && submission.echo.placement !== 'queued' && { reportQueuedForLater: true }),
          newSession,
          expectedTurnId, modelDraft: selection, permissionDraft: profileId,
          planMode: plan !== undefined ? 'plan' : initialPlanMode(), worktree: worktreeSelection(worktree),
          ...(unarchive && { unarchive: true }) }, signal)
        if (result.planMode) {
          if (!worktree) session.publishPlanMode(result.planMode, planRevision)
          goalDraft?.clear(draft)
        }
        if (newSession && result.thread) {
          acceptSubmittedSettings(selection, profileId, before, result, worktree)
          openSubmittedThread(result, requestId)
        } else if (worktree && result.thread) {
          worktreeDraft.clear(worktree)
          openSubmittedThread(result, requestId)
        } else {
          acceptSubmittedSettings(selection, profileId, before, result)
          if (result.queuedForLater) confirmQueuedForLater(requestId, submission)
        }
        return accepted
      } catch (error) {
        // 如果回显已被原生历史或队列确认，网络错误也不应恢复草稿造成重复发送。
        const entries = events.getSnapshot().entries
        const current = submissions.get(requestId)
        if (current) {
          // 回执丢失后，已经可操作的原生队列项接手。条目已离开队列时仍等历史确认。
          current.queuedForLater = true
          if (observeSubmission(requestId, current, entries)) return accepted
        }
        if (submission?.observed) return accepted
        if (!current && (historySettlement(requestId, entries) || queueStore.getSnapshot().some(item => item.clientUserMessageId === requestId))) {
          clearDrafts(selection, profileId)
          return accepted
        }
        retire(requestId, failedSubmission)
        rememberNewSessionRecovery(error)
        if (goal) {
          // Goal 的错误随输入模式销毁。原生发送 Toast 会在退出模式后继续显示旧错误。
          const result = failure(error)
          if (goalDraft.getSnapshot() === goal) updateState(state => { state.goalError = result.error })
          return result
        }
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
        if (kind === 'check-steer') {
          const accept = history.captureQueueView()
          const { data, steers } = await native('queue', { operation: 'list' })
          await accept(data, steers)
          return accepted
        }
        await native('queue', { queuedSubmissionId, operation: kind, ...options })
        return accepted
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
