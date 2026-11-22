/** 将该条原生用户消息中的文本段装入同一个编辑框。附件和引用由原生消息单独保存。 */
export function userInputText(content) {
  return content.filter(part => part.type === 'text').map(part => part.text).join('')
}

function commandArguments(content, command) {
  const text = userInputText(content).trim()
  const separator = text.search(/\s/u)
  const token = separator < 0 ? text : text.slice(0, separator)
  if (token === command) return separator < 0 ? '' : text.slice(separator).trimStart()
}

/** 识别桌面端随目标保存的用户消息。 */
export function goalCommandObjective(content) {
  return commandArguments(content, '/goal') || undefined
}

/** 裸命令返回空文本，附任务时返回待提交的正文。 */
export function planCommandText(content) {
  return commandArguments(content, '/plan')
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
