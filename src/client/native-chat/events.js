import { inlineAttachmentId } from './attachments.js'
import { projectQuestionReply, projectTool } from './tools.js'
import { projectFileLinks } from './file-links.js'
import { projectVisualizeReferences } from './visualize.js'
import { subagentActivityEvent, subagentActivityKinds } from './subagent-activity.js'
import { questionReplies } from '../../shared/question-replies.js'
import { goalCommandObjective } from '../../shared/user-input.js'
import { fileAttachmentOf, splitFileAttachmentInput } from '../../shared/file-attachments.js'

// 最新页从固定位置向前分配序号，为后续向前分页留下空间，已发布序号无需重排。
const newestHistoryBoundary = 2 ** 32

function milliseconds(seconds) {
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

function textBlock(text) {
  return { type: 'text', text }
}

function userBlock(part, image) {
  if (part.type === 'text') return textBlock(part.text)
  if (image) return { type: 'image', attachment: image.attachment }
  return textBlock(part.path || part.name || (part.type === 'image' ? '图片附件' : part.type))
}

/** 待发和已发送的原生用户内容共用附件投影。 */
export function projectUserContent(id, content, attachments, fileLocation) {
  return content.flatMap((original, index) => splitFileAttachmentInput(original).map(part => {
    const file = fileAttachmentOf(part)
    if (file) {
      const downloadUrl = fileLocation && `api/codex/file-download?${new URLSearchParams({
        ...fileLocation, attachmentId: file.attachmentId, name: file.name,
      })}`
      return { type: 'file', attachment: { ...file, ...(downloadUrl && { downloadUrl }) } }
    }
    return userBlock(part, attachments?.get(inlineAttachmentId(id, index)))
  }))
}

function questionMarkdown(questions) {
  const literal = text => text.replace(/[\\`*_{}\[\]()#+\-.!|><]/g, '\\$&')
  return questions.map(({ title, options }) => {
    const line = `**${literal(title)}**`
    if (!options?.length) return line
    return `${line}\n\n${options.map(option => `- ${literal(option)}`).join('\n')}`
  }).join('\n\n')
}

function renderChatMarkdown(text, item, cwd) {
  return projectFileLinks(item.type === 'agentMessage' ? projectVisualizeReferences(text) : text, cwd)
}

function assistantBlock(item, cwd, renderMarkdown) {
  if (item.type === 'reasoning') {
    const text = item.summary?.join('\n\n')
    return text?.trim() ? { type: 'reasoning', text } : undefined
  }
  const nativeText = item.review ?? item.text
  const text = nativeText?.trim() ? renderMarkdown(nativeText, item, cwd) : undefined
  const questions = item.type === 'agentMessage' ? item.questions : undefined
  if (!questions?.length) return text && textBlock(text)

  // Codex 异步提问会把同一份题面和选项预先写入正文；独立正文和只含结构化题目的旧记录仍需补齐题面。
  const nativeQuestionText = questions.map(({ title, options }) =>
    [title, ...(options ?? []).map(option => `- ${option}`)].join('\n')).join('\n\n')
  if (text && nativeText.trim() === nativeQuestionText.trim()) return textBlock(text)

  const markdown = questionMarkdown(questions)
  return textBlock(text ? `${text}\n\n${markdown}` : markdown)
}

function turnEndReason({ status, error }) {
  if (status === 'failed') {
    return { kind: 'error', error: { code: 'UNKNOWN', message: error?.message ?? 'Codex 轮次执行失败。' } }
  }
  if (status === 'interrupted') return { kind: 'aborted', reason: { kind: 'legacy' } }
  return { kind: 'completed' }
}

function mergeCancelledToolCalls(items, cancelled) {
  if (!cancelled?.length) return items
  const pending = new Map(cancelled.map(call => [call.id, call]))
  const native = items.map(item => {
    const call = pending.get(item.id)
    if (!call) return item
    pending.delete(item.id)
    if (item.type !== 'commandExecution' || item.status !== 'inProgress') return item
    // 有启动记录却缺少原生完成事件时，沿用命令的身份和已收到的输出。
    return { ...item, status: 'failed', completedAtMs: call.completedAtMs,
      aggregatedOutput: [item.aggregatedOutput, call.output].filter(Boolean).join('\n') }
  })
  const timeOf = item => item.completedAtMs ?? item.startedAtMs ?? Infinity
  const recovered = [...pending.values()]
    .map(call => ({ ...call, type: 'cancelledToolCall', id: `codex:cancelled:${call.id}` }))
    .sort((a, b) => timeOf(a) - timeOf(b))
  // 保留原生条目的相对顺序，将补充记录插到其完成时间所在的位置。
  let index = 0
  const merged = []
  for (const item of native) {
    const time = timeOf(item)
    while (index < recovered.length && Number.isFinite(time) && timeOf(recovered[index]) < time) merged.push(recovered[index++])
    merged.push(item)
  }
  return [...merged, ...recovered.slice(index)]
}

function turnEvents(turn, number, {
  provider = 'codex', model = '', createdAt, attachments, cancelledToolCalls, turnWorkingDirectories,
  goalInputs, goalCompletions, renderMarkdown = renderChatMarkdown, liveTurns, fileThreadId,
}, firstChanged = 0) {
  const source = { kind: 'model', provider, model }
  const cancelled = cancelledToolCalls?.get(turn.id)
  const cwd = turnWorkingDirectories?.[turn.id]
  const goalInput = goalInputs?.[turn.id]
  const goalCompletion = goalCompletions?.[turn.id]
  // 补录工具按时间插入，原生条目位置无法直接映射到合并后的事件位置。
  const previous = cancelled?.length ? undefined : liveTurns?.get(turn.id)
  const checkpoints = previous?.checkpoints ?? (!cancelled?.length && turn.status === 'inProgress' && liveTurns ? [] : undefined)
  let from = previous ? Math.min(firstChanged, checkpoints.length) : 0
  // 成功结束时，旧记录中尚未确认完成的压缩也会生成结束事件。
  if (turn.status === 'completed') from = Math.min(from, previous?.openCompactionIndex ?? Infinity)
  const events = []
  function emit(type, time, data, surfaceOp) {
    events.push({ type, time, data, ...(surfaceOp && { surfaceOp }) })
  }

  const items = mergeCancelledToolCalls(turn.items, cancelled)
  const explicitStart = milliseconds(turn.startedAt)
  let firstTimedIndex = previous?.firstTimedIndex ?? Infinity
  if (explicitStart == null && from <= firstTimedIndex) {
    firstTimedIndex = Infinity
    for (let index = from; index < items.length; index++) {
      const { startedAtMs, completedAtMs } = items[index]
      if (startedAtMs == null && completedAtMs == null) continue
      firstTimedIndex = index
      break
    }
  }
  const firstTimedItem = items[firstTimedIndex]
  const startedAt = explicitStart ?? firstTimedItem?.startedAtMs
    ?? firstTimedItem?.completedAtMs ?? milliseconds(createdAt) ?? 0

  let goalMessageId = goalInput?.messageId
  let goalItemIndex = previous?.goalItemIndex ?? Infinity
  let syntheticGoal
  if (goalInput && !goalMessageId) {
    if (from <= goalItemIndex) {
      goalItemIndex = Infinity
      for (let index = from; index < items.length; index++) {
        const item = items[index]
        if (item.type !== 'userMessage' || goalCommandObjective(item.content) !== goalInput.objective) continue
        goalItemIndex = index
        break
      }
    }
    goalMessageId = items[goalItemIndex]?.id
    if (!goalMessageId) {
      goalMessageId = `codex:goal:${turn.id}`
      syntheticGoal = { type: 'userMessage', id: goalMessageId, startedAtMs: goalInput.time ?? startedAt,
        content: [textBlock(`/goal ${goalInput.objective}`)] }
    }
  }
  const turnIdentity = { turn: number, codexTurnId: turn.id }
  if (startedAt !== previous?.startedAt || goalMessageId !== previous?.goalMessageId) from = 0
  if (from === 0) emit('turn/start', startedAt, turnIdentity)

  // 每条原生记录保存后续投影所需的步号、时间和事件位置。改写时从首条变化恢复。
  let { offset = 0, step = 0, activity = false, hasUserInput = false, lastTime = startedAt } = checkpoints?.[from - 1] ?? {}
  if (checkpoints) checkpoints.length = from
  const coordinates = () => ({ turn: number, step })
  function projectItem(item) {
    const isSubagentActivity = item.type === 'subAgentActivity'
    if (isSubagentActivity && !subagentActivityKinds.includes(item.kind)) return
    const isUser = item.type === 'userMessage'
    const replies = isUser ? questionReplies(item.content) : undefined
    const reviewPhase = item.type === 'enteredReviewMode' ? 'commentary' : item.type === 'exitedReviewMode' ? 'final_answer' : undefined
    const isAssistant = item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan' || reviewPhase != null
    const block = isAssistant ? assistantBlock(item, cwd, renderMarkdown) : undefined
    if (isAssistant && !block) return

    const start = item.startedAtMs ?? item.completedAtMs ?? lastTime
    const end = item.completedAtMs ?? start
    // DSH 以 step 存放一条 Assistant 消息，首步需包含用户输入以生成正常的对话导航。
    if (step === 0 || (activity && (isAssistant || isUser))) {
      if (step > 0) emit('step/end', lastTime, coordinates())
      step++
      emit('step/start', start, coordinates())
      activity = false
    }
    lastTime = end

    if (isUser) {
      if (!replies) {
        const fileLocation = fileThreadId && { threadId: fileThreadId, turnId: turn.id, itemId: item.id }
        const content = projectUserContent(item.id, item.content, attachments, fileLocation)
        const message = { id: item.id, role: 'user', content, source: { kind: 'user', ...(item.clientId && { rpcId: item.clientId }),
          ...(goalMessageId && item.id === goalMessageId && { codexGoal: true }) } }
        if (hasUserInput) {
          // Codex 的轮内追加已被正式接纳。DSH 用 next-step 的领取记录识别同一个用户气泡为插话。
          emit('agent/inbox/spliced', start, { target: 'next-step', start: 0, inserted: [message] })
          emit('agent/inbox/spliced', start, { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
        }
        emit('user/message', start, message, 'append')
        hasUserInput = true
        return
      }
      hasUserInput = true
    }
    activity = true
    if (isSubagentActivity) {
      const { id, kind, agentThreadId, agentPath } = item
      emit(subagentActivityEvent, end, { ...coordinates(), id, kind, agentThreadId, agentPath })
      return
    }
    if (item.type === 'contextCompaction') {
      // 使用 DSH 自带的压缩行，完成时间来自原生条目。旧记录也可用成功结束的轮次确认完成。
      const data = { ...coordinates(), compactionId: item.id }
      emit('compaction/start', start, data)
      if (item.completedAtMs != null || turn.status === 'completed') emit('compaction/end', end, data)
      return
    }
    if (isAssistant) {
      const phase = reviewPhase ?? item.phase
      emit('assistant/message', end, {
        ...coordinates(),
        message: { id: item.id, role: 'assistant', content: [block], source },
        stream: [],
        ...(phase != null && { codexPhase: phase }),
      }, 'append')
      return
    }

    const { name, args, output, meta, isError } = replies ? projectQuestionReply(replies) : projectTool(item, cwd)
    emit('tool/call', start, { ...coordinates(), callId: item.id, name, arguments: JSON.stringify(args) })
    if (item.status === 'inProgress') return
    emit('tool/result', end, {
      ...coordinates(),
      message: {
        id: item.id,
        role: 'tool',
        content: [textBlock(output)],
        source: { kind: 'tool', callId: item.id },
        toolCallId: item.id,
        isError,
      },
      ...(meta && { meta }),
    }, 'append')
  }

  if (from === 0 && syntheticGoal) projectItem(syntheticGoal)
  let openCompactionIndex = previous?.openCompactionIndex ?? Infinity
  if (from <= openCompactionIndex) openCompactionIndex = Infinity
  for (let index = from; index < items.length; index++) {
    const item = items[index]
    projectItem(item)
    checkpoints?.push({ offset: offset + events.length, step, activity, hasUserInput, lastTime })
    if (item.type === 'contextCompaction' && item.completedAtMs == null) openCompactionIndex = Math.min(openCompactionIndex, index)
  }
  if (checkpoints && turn.status === 'inProgress') {
    liveTurns.set(turn.id, { checkpoints, firstTimedIndex, startedAt, goalMessageId, goalItemIndex, openCompactionIndex })
  } else liveTurns?.delete(turn.id)

  if (turn.status !== 'inProgress') {
    if (step > 0) emit('step/end', lastTime, coordinates())
    emit('turn/end', milliseconds(turn.completedAt) ?? lastTime, {
      ...turnIdentity,
      reason: turnEndReason(turn),
      ...(goalCompletion && { codexGoalCompletion: goalCompletion }),
      ...(turn.error && { codexError: turn.error }),
    })
  }
  return { offset, events }
}

function eventEntries(events, start) {
  return events.map((event, index) => ({ type: 'event', event: { ...event, seq: start + index } }))
}

/** 从首个变化的原生条目继续转换，给出应替换的事件后缀及其位置。 */
export function projectCodexTurnUpdate(turn, { firstSeq, beforeTurn = newestHistoryBoundary, ...options }, firstChanged) {
  const { offset, events } = turnEvents(turn, beforeTurn - 1, options, firstChanged)
  return { offset, entries: eventEntries(events, (firstSeq ?? newestHistoryBoundary - events.length) + offset) }
}

/** 将按时间正序排列的 Codex 轮次投影为原版 DSH Conversation 的内存事件窗口。 */
export function projectCodexTurns(turns, {
  beforeSeq = newestHistoryBoundary,
  beforeTurn = newestHistoryBoundary,
  firstSeq,
  ...options
} = {}) {
  const firstTurn = beforeTurn - turns.length
  const events = turns.flatMap((turn, index) => turnEvents(turn, firstTurn + index, options).events)
  return eventEntries(events, firstSeq ?? beforeSeq - events.length)
}
