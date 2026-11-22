import { CodexRpcError, readCodexPages } from './app-server.mjs'
import { userInputText } from '../shared/user-input.js'
import { questionReplies } from '../shared/question-replies.js'

/** 从原生记录提取该轮首条用户输入。只替换文本，附件与引用继续使用 Codex 原对象。 */
export async function editedInput(request, threadId, turnId, itemId, text) {
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
  if (text === userInputText(content)) return content
  const edited = { type: 'text', text, text_elements: [] }
  const firstText = content.findIndex(part => part.type === 'text')
  const input = content.flatMap((part, index) => {
    if (part.type !== 'text') return [part]
    return index === firstText && text.trim() ? [edited] : []
  })
  if (firstText === -1 && text.trim()) input.push(edited)
  if (!input.length) throw new CodexRpcError({ code: -32602, message: '请输入消息内容。' })
  return input
}

/** 回退已提交时单独报告发送结果，避免让界面重新执行破坏性的回退。 */
export async function sendAfterRevert(request, threadId, input) {
  try {
    const { thread } = await request('thread/read', { threadId })
    if (thread.status?.type !== 'idle') return { error: '历史已回退。会话状态已变化，请复制修改后的消息并在 CLI 中发送。' }
    return await request('turn/start', { threadId, input })
  } catch (error) {
    return { error: error instanceof CodexRpcError
      ? `历史已回退，重新发送失败。${error.message}`
      : '历史已回退，无法确认消息是否发送。请先检查当前会话。' }
  }
}
