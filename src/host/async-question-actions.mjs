import { createHash } from 'node:crypto'
import { CodexRpcError, readCodexPages, withCodexReader } from './app-server.mjs'
import { readConversationQueue } from './conversation-actions.mjs'
import { readLatestTurn } from './live-history.mjs'
import { addressableThread, createThreadSubmissionQueue, resumeThread, waitForThreadActivity } from './thread-runtime.mjs'
import { answeredAsyncQuestions, asyncQuestionItemId, encodeQuestionReplies } from '../shared/question-replies.js'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

function validFields(threadId, turnId, itemId, answers) {
  return [threadId, turnId, itemId].every(value => typeof value === 'string' && value.trim())
    && Array.isArray(answers) && answers.length > 0 && answers.every(entry => Number.isSafeInteger(entry?.index)
      && entry.index >= 0 && typeof entry.answer === 'string' && entry.answer.trim())
    && new Set(answers.map(entry => entry.index)).size === answers.length
}

function userInputs(items) {
  return items.filter(item => item.type === 'userMessage').map(item => item.content)
}

function staleQuestion() {
  return json({ error: '会话已进入新轮次，原问题不再等待回答。' }, 409)
}

/** 从异步提问之后的原生条目识别直接插入同一轮的答复。 */
async function readFollowingAnswers(request, threadId, turnId, itemId) {
  return readCodexPages(async cursor => {
    const page = await request('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'asc', cursor })
    return { data: userInputs(page.data.map(entry => entry.item)), nextCursor: page.nextCursor }
  }, { type: 'item', itemId })
}

async function submit(request, threadId, turnId, itemId, answers, signal) {
  const thread = await addressableThread(request, threadId)
  // 优先读队列，再读历史，覆盖原生正在领取待发消息的情况。
  const queued = await readConversationQueue(request, threadId)
  const legacy = thread.historyMode === 'legacy'
  let item
  let saved
  if (legacy) {
    // 旧式历史不提供单条读取和条目游标。最近一轮已包含定位和防重所需的记录。
    const turn = await readLatestTurn(request, threadId, 'full')
    if (turn?.id !== turnId) return staleQuestion()
    const position = turn.items.findIndex(entry => entry.id === itemId)
    item = turn.items[position]
    saved = userInputs(turn.items.slice(position + 1))
  } else {
    const { data } = await request('thread/items/read', { threadId, turnId, itemIds: [itemId] })
    item = data.find(entry => entry.turnId === turnId && entry.item.id === itemId)?.item
  }
  if (item?.type !== 'agentMessage' || !item.questions?.length) return json({ error: '该异步提问已从会话移除。' }, 409)
  if (answers.some(({ index }) => index >= item.questions.length)) return json({ error: '答复与原生问题不匹配。' }, 400)
  saved ??= await readFollowingAnswers(request, threadId, turnId, itemId)
  const answered = answeredAsyncQuestions([...queued.map(entry => entry.input), ...saved])
  const replies = answers.toSorted((left, right) => left.index - right.index).map(({ index, answer }) => ({
    questionItemId: asyncQuestionItemId(itemId, index), question: item.questions[index].title, answer: answer.trim(),
  })).filter(reply => !answered.has(reply.questionItemId))
  if (!replies.length || answered.has(itemId)) return json({ submitted: false })

  if (!legacy && (await readLatestTurn(request, threadId, 'notLoaded'))?.id !== turnId) return staleQuestion()
  if (thread.status?.type === 'notLoaded') {
    try {
      await resumeThread(request, thread)
    } catch (error) {
      if (error instanceof CodexRpcError) return json({ error: `加载会话失败，答复尚未入队。${error.message}` }, 409)
      return json({ error: '未收到加载会话的确认，答复尚未入队。' }, 503)
    }
    if ((await readLatestTurn(request, threadId, 'notLoaded'))?.id !== turnId) return staleQuestion()
  }

  const identity = JSON.stringify([threadId, ...replies.map(reply => reply.questionItemId)])
  const clientUserMessageId = `dsh-codex-question-${createHash('sha256').update(identity).digest('hex')}`
  await request('thread/queue/add', { threadId, clientUserMessageId,
    input: [{ type: 'text', text: encodeQuestionReplies(replies), text_elements: [] }] })
  if (thread.status?.type === 'notLoaded') await waitForThreadActivity(request, threadId, signal)
  return json({ submitted: true })
}

/** 从已保存的原生问题构建答复。网页并发只限制同一条提问的提交。 */
export function createAsyncQuestionActionRoute(socketPath, ownerSignal, submitThread = createThreadSubmissionQueue()) {
  const submitting = new Set()
  return {
    path: '/api/codex/async-question-answer',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const { threadId, turnId, itemId, answers } = (await request.json().catch(() => null)) ?? {}
      if (!validFields(threadId, turnId, itemId, answers)) return json({ error: '异步问题或答案格式无效。' }, 400)
      const key = JSON.stringify([threadId, itemId])
      if (submitting.has(key)) return json({ error: '这条提问已有答复正在提交。' }, 409)
      submitting.add(key)
      try {
        const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
        return await submitThread(threadId, () => withCodexReader(socketPath, signal, rpc => submit(rpc, threadId, turnId, itemId, answers, signal)))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          const reason = error.data?.reason
          return json({ error: error.message, ...(reason && { reason }) }, reason ? 409
            : error.code === -32600 || error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法确认答案是否送达。请检查 Codex 会话与待发队列。' }, 503)
      } finally {
        submitting.delete(key)
      }
    },
  }
}
