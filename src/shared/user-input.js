/** 将该条原生用户消息中的文本段装入同一个编辑框。附件和引用由原生消息单独保存。 */
export function userInputText(content) {
  return content.filter(part => part.type === 'text').map(part => part.text).join('')
}

/** 替换原生输入中的文本，保留独立记录的附件与引用。 */
export function replaceUserInputText(content, text) {
  if (text === userInputText(content)) return content
  const edited = { type: 'text', text, text_elements: [] }
  const firstText = content.findIndex(part => part.type === 'text')
  const input = content.flatMap((part, index) => {
    if (part.type !== 'text') return [part]
    return index === firstText && text.trim() ? [edited] : []
  })
  if (firstText === -1 && text.trim()) input.push(edited)
  return input
}
