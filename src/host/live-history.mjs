import { CodexRpcError, readCodexPages } from './app-server.mjs'

const turnList = 'thread/turns/list'
const itemList = 'thread/items/list'

/** 新线程在首条消息落盘前仍然可以使用输入框。原生 CLI 对同一条错误也视为空历史。 */
export async function readThreadTurns(request, params) {
  try {
    return await request(turnList, params)
  } catch (error) {
    if (!params.cursor && error instanceof CodexRpcError
      && error.message.includes('thread/turns/list is unavailable before first user message')) {
      return { data: [], nextCursor: null, backwardsCursor: null }
    }
    throw error
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function needsUpdate(item) {
  if (item.status === 'inProgress') return true
  return item.completedAtMs == null && ['agentMessage', 'reasoning', 'plan'].includes(item.type)
}

function readThrough(request, method, parameters, cursor) {
  return readCodexPages(next => request(method, { ...parameters, ...(next != null && { cursor: next }) }), cursor)
}

/** 跟随活跃尾部。分页历史通过原生条目锚点读取新增记录和需要刷新的未完成项。 */
export function createHistoryTail(request, thread, initialPage) {
  const threadId = thread.id
  const paginated = thread.historyMode === 'paginated'
  const itemsView = paginated ? 'notLoaded' : 'full'
  const seen = new Map()
  for (const { items, ...turn } of initialPage.data) {
    seen.set(turn.id, { turn, items: new Map(items.map(item => [item.id, item])) })
  }
  let lastTurnId = initialPage.data[0]?.id
  let tailCursor = initialPage.backwardsCursor

  async function readItems(turnId, previous) {
    const known = previous ? [...previous.items.values()] : []
    const firstOpen = known.findIndex(needsUpdate)
    const anchor = firstOpen < 0 ? known.at(-1) : known[firstOpen - 1]
    const rows = await readThrough(request, itemList, { threadId, turnId, limit: 100, sortDirection: 'asc' },
      anchor ? { type: 'item', itemId: anchor.id } : null)
    return rows.map(({ item, startedAtMs, completedAtMs }) => ({
      ...item,
      startedAtMs: startedAtMs ?? item.startedAtMs,
      completedAtMs: completedAtMs ?? item.completedAtMs,
    }))
  }

  return {
    async readChanges() {
      const head = await readThreadTurns(request, { threadId, limit: 1, sortDirection: 'desc', itemsView })
      const latest = head.data[0]
      if (!latest) return lastTurnId ? null : []
      if (latest.id !== lastTurnId && seen.has(latest.id)) return null
      let turns = [latest]
      if (latest.id !== lastTurnId) {
        try {
          turns = await readThrough(request, turnList, { threadId, limit: 100, sortDirection: 'asc', itemsView }, tailCursor)
        } catch (error) {
          // 原生已发出的游标变为无效，通常是回退删去了它的锚点。
          if (tailCursor && error instanceof CodexRpcError && error.code === -32602) return null
          throw error
        }
      }
      if (!turns.some(turn => turn.id === latest.id)) return null

      const changes = []
      for (const { items, ...turn } of turns) {
        const previous = seen.get(turn.id)
        const sameTurn = previous && same(previous.turn, turn)
        if (paginated && sameTurn && turn.status !== 'inProgress') continue
        const native = paginated ? await readItems(turn.id, previous) : items
        const rows = previous?.items ?? new Map()
        const changed = native.filter(item => !same(rows.get(item.id), item))
        if (!sameTurn || changed.length) changes.push({ turn, items: changed })
        for (const item of changed) rows.set(item.id, item)
        seen.set(turn.id, { turn, items: rows })
      }

      // 较早的轮次只保留状态，用于辨认游标重复出现的锚点。
      const tailId = turns.at(-1).id
      for (const [id, view] of seen) {
        if (id !== tailId && view.turn.status !== 'inProgress') view.items.clear()
      }
      lastTurnId = latest.id
      tailCursor = head.backwardsCursor
      return changes
    },
  }
}
