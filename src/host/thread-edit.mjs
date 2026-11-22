import { CodexRpcError, readCodexPages } from './app-server.mjs'
import { questionReplies } from '../shared/question-replies.js'
import { waitForThreadActivity } from './thread-runtime.mjs'

/** 从原生记录提取该轮首条可编辑的用户输入，保留 Codex 原始内容。 */
export async function readEditableInput(request, threadId, turnId, itemId) {
  const rows = await readCodexPages(async cursor => {
    const page = await request('thread/items/list', {
      threadId, turnId, limit: 25, sortDirection: 'asc', ...(cursor != null && { cursor }),
    })
    const { item } = page.data.find(({ item }) => item.type === 'userMessage') ?? {}
    return item ? { data: [item], nextCursor: null } : { data: [], nextCursor: page.nextCursor }
  })
  const [message] = rows
  if (message?.id !== itemId) throw new CodexRpcError({ code: -32602, message: '只支持编辑每轮开头的用户消息。' })

  const { content } = message
  if (questionReplies(content)) throw new CodexRpcError({ code: -32602, message: '这是一条问答记录，可通过整轮回退重新开始。' })
  return content
}

/** 回退已提交时单独报告发送结果，避免让界面重新执行破坏性的回退。 */
export async function sendAfterRevert(request, threadId, input, signal) {
  try {
    const { thread } = await request('thread/read', { threadId })
    if (thread.status?.type !== 'idle') return { error: '历史已回退。会话状态已变化，请复制修改后的消息并在 CLI 中发送。' }
    const sent = await request('turn/start', { threadId, input })
    await waitForThreadActivity(request, threadId, signal)
    return sent
  } catch (error) {
    return { error: error instanceof CodexRpcError
      ? `历史已回退，重新发送失败。${error.message}`
      : '历史已回退，无法确认消息是否发送。请先检查当前会话。' }
  }
}
