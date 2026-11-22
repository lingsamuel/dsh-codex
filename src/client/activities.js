/** 合并相邻的命令，保留夹在命令之间的消息和活动。 */
export function groupCommands(items) {
  const groups = []
  for (const item of items) {
    const previous = groups.at(-1)
    if (item.type === 'commandExecution' && previous?.[0].type === item.type) previous.push(item)
    else groups.push([item])
  }
  return groups
}
