/** 按可见记录分组。没有可展示内容的事件不应在布局中占位或打断命令组。 */
export function groupVisibleItems(items) {
  const groups = []
  for (const item of items) {
    if (item.type === 'reasoning' && !item.summary?.some(part => part.trim())) continue
    if ((item.type === 'agentMessage' || item.type === 'plan') && !item.text?.trim()) continue
    const previous = groups.at(-1)
    if (item.type === 'commandExecution' && previous?.[0].type === item.type) previous.push(item)
    else groups.push([item])
  }
  return groups
}
