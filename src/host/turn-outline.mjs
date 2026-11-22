import { mergePages } from '../shared/pages.js'
import { questionReplies } from '../shared/question-replies.js'
import { readCodexPages } from './app-server.mjs'

/** 仅取旧轮次的原生摘要，点导航标记时再加载正文。 */
export async function readTurnOutline(request, threadId, cursor) {
  const turns = await readCodexPages(cursor => request('thread/turns/list', {
    threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'summary',
  }), cursor)
  return mergePages([], turns).map(({ id, items }) => {
    const first = items?.find(item => item.type === 'userMessage')
    const last = items?.findLast(item => item.type === 'agentMessage')
    const replies = first && questionReplies(first.content)
    const prompt = replies?.map(({ question, answer }) => `${question} ${answer}`).join(' ')
      ?? first?.content.filter(part => part.type === 'text').map(part => part.text).join(' ') ?? ''
    return {
      id,
      prompt: prompt.slice(0, 160),
      response: last?.text?.slice(0, 320) ?? '',
    }
  })
}
