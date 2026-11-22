const start = '<send_user_message_question_reply>'
const end = '</send_user_message_question_reply>'
const ideContext = '# Context from my IDE setup:\n'
const ideRequest = '\n## My request for Codex:\n'

/** 识别 Codex CLI 和桌面端保存的独立问答消息。嵌在普通提示词里的示例保持原样。 */
export function questionReplies(content) {
  const parts = content.filter(part => part.type !== 'skill' && part.type !== 'mention')
  if (parts.length !== 1 || parts[0].type !== 'text') return

  let text = parts[0].text.trim()
  if (text.startsWith(ideContext)) {
    const request = text.lastIndexOf(ideRequest)
    if (request === -1) return
    text = text.slice(request + ideRequest.length).trim()
  }
  if (!text.startsWith(start) || !text.endsWith(end)) return

  try {
    const payload = JSON.parse(text.slice(start.length, -end.length))
    const replies = Array.isArray(payload) ? payload : [payload]
    if (replies.length && replies.every(reply => typeof reply?.questionItemId === 'string'
      && typeof reply.question === 'string' && typeof reply.answer === 'string')) return replies
  } catch {
    // 与 Codex 一样，把不完整或无效的载荷视为普通输入。
  }
}
