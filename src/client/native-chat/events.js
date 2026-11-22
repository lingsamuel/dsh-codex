import { inlineAttachmentId } from './attachments.js'
import { projectTool } from './tools.js'

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

function assistantBlock(item) {
  const text = item.type === 'reasoning'
    ? item.summary?.join('\n\n')
    : item.text
  if (!text?.trim()) return undefined
  return { type: item.type === 'reasoning' ? 'reasoning' : 'text', text }
}

function turnEndReason({ status, error }) {
  if (status === 'failed') {
    return { kind: 'error', error: { code: 'UNKNOWN', message: error?.message ?? 'Codex 轮次执行失败。' } }
  }
  if (status === 'interrupted') return { kind: 'aborted', reason: { kind: 'legacy' } }
  return { kind: 'completed' }
}

function turnEvents(turn, number, source, createdAt, attachments) {
  const events = []
  function emit(type, time, data, surfaceOp) {
    events.push({ type, time, data, ...(surfaceOp && { surfaceOp }) })
  }

  const items = turn.items
  const firstTimedItem = items.find(item => item.startedAtMs != null || item.completedAtMs != null)
  const startedAt = milliseconds(turn.startedAt) ?? firstTimedItem?.startedAtMs
    ?? firstTimedItem?.completedAtMs ?? milliseconds(createdAt) ?? 0
  const turnIdentity = { turn: number, codexTurnId: turn.id }
  emit('turn/start', startedAt, turnIdentity)

  let step = 0
  let activity = false
  let lastTime = startedAt
  const coordinates = () => ({ turn: number, step })
  for (const item of items) {
    const isUser = item.type === 'userMessage'
    const isAssistant = item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan'
    const block = isAssistant ? assistantBlock(item) : undefined
    if (isAssistant && !block) continue

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
      const content = item.content.map((part, index) => userBlock(part, attachments?.get(inlineAttachmentId(item.id, index))))
      emit('user/message', start, { id: item.id, role: 'user', content, source: { kind: 'user' } }, 'append')
      continue
    }
    activity = true
    if (isAssistant) {
      emit('assistant/message', end, {
        ...coordinates(),
        message: { id: item.id, role: 'assistant', content: [block], source },
        stream: [],
        ...(item.phase != null && { codexPhase: item.phase }),
      }, 'append')
      continue
    }

    const { name, args, output, meta, isError } = projectTool(item)
    emit('tool/call', start, { ...coordinates(), callId: item.id, name, arguments: JSON.stringify(args) })
    if (item.status === 'inProgress') continue
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

  if (turn.status !== 'inProgress') {
    if (step > 0) emit('step/end', lastTime, coordinates())
    emit('turn/end', milliseconds(turn.completedAt) ?? lastTime, {
      ...turnIdentity,
      reason: turnEndReason(turn),
      ...(turn.error && { codexError: turn.error }),
    })
  }
  return events
}

/** 将按时间正序排列的 Codex 轮次投影为原版 DSH Conversation 的内存事件窗口。 */
export function projectCodexTurns(turns, {
  beforeSeq = newestHistoryBoundary,
  beforeTurn = newestHistoryBoundary,
  provider = 'codex',
  model = '',
  createdAt,
  attachments,
} = {}) {
  const source = { kind: 'model', provider, model }
  const firstTurn = beforeTurn - turns.length
  const events = turns.flatMap((turn, index) => turnEvents(turn, firstTurn + index, source, createdAt, attachments))
  const firstSeq = beforeSeq - events.length
  return events.map((event, index) => ({ type: 'event', event: { ...event, seq: firstSeq + index } }))
}
