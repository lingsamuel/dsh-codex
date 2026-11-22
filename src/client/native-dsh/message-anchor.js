/** 与 DSH 原生聊天节点使用同一个定位身份。 */
export function messageAnchor(event) {
  if (event.type === 'user/message') return { kind: 'input-message', id: event.data.id }
  if (event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text')) {
    return { kind: 'assistant-step', id: `${event.data.turn}:${event.data.step}` }
  }
}

export function findRenderedMessage(scope, target) {
  const key = `${target.kind.length}:${target.kind}${target.id}`
  return scope.querySelector(`[data-chat-node-key="${CSS.escape(key)}"]`)
}
