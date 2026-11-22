/** 将该条原生用户消息中的文本段装入同一个编辑框。附件和引用由原生消息单独保存。 */
export function userInputText(content) {
  return content.filter(part => part.type === 'text').map(part => part.text).join('')
}
