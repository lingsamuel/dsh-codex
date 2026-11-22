import { projectCodexTurns } from '../client/native-chat/events.js'

/** 导出使用相同的对话事件转换，正文保留 Codex 原始 Markdown。 */
export function formatCodexMarkdown(thread, turns, formatSessionMarkdown, cancelledToolCalls = []) {
  const title = thread.name?.trim() || thread.preview?.trim() || thread.id
  const events = projectCodexTurns(turns, {
    createdAt: thread.createdAt,
    renderMarkdown: text => text,
    cancelledToolCalls: Map.groupBy(cancelledToolCalls, call => call.turnId),
    firstSeq: 1,
  }).map(({ event }) => event)
  events.unshift({ type: 'session/title', data: { title } })
  return formatSessionMarkdown(events)
}
