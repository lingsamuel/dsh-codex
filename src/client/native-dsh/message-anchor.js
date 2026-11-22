/** 与 DSH 原生聊天节点使用同一个定位身份。 */
export function messageAnchor(event) {
  if (event.type === 'user/message') return { kind: 'input-message', id: event.data.id }
  if (event.type === 'tool/result' && event.data.meta?.codexQuestionReply) {
    return { kind: 'tool-call', id: event.data.message.id }
  }
  if (event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text')) {
    return { kind: 'assistant-step', id: `${event.data.turn}:${event.data.step}` }
  }
}

export function findRenderedMessage(scope, target) {
  if (target.kind === 'tool-call') return scope.querySelector(`[data-chat-call-id="${CSS.escape(target.id)}"]`)
  const key = `${target.kind.length}:${target.kind}${target.id}`
  return scope.querySelector(`[data-chat-node-key="${CSS.escape(key)}"]`)
}
