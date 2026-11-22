import { CodexRpcError, readCodexPages } from './app-server.mjs'

const turnList = 'thread/turns/list'
const itemList = 'thread/items/list'

/** 原生 App Server 的空线程尚无历史文件，和已经持久化的空历史不同。 */
export function hasNoMaterializedHistory(error) {
  return error instanceof CodexRpcError && error.message.includes('thread/turns/list is unavailable before first user message')
}

/** 新线程在首条消息落盘前仍然可以使用输入框。原生 CLI 对同一条错误也视为空历史。 */
export async function readThreadTurns(request, params) {
  try {
    return await request(turnList, params)
  } catch (error) {
    if (!params.cursor && hasNoMaterializedHistory(error)) {
      return { data: [], nextCursor: null, backwardsCursor: null }
    }
    throw error
  }
}

/** 查询原生历史头，用同一分页入口读取旧版与分页会话。 */
export async function readLatestTurn(request, threadId, itemsView) {
  const { data } = await readThreadTurns(request, { threadId, limit: 1, sortDirection: 'desc', itemsView })
  return data[0]
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

function flattenItem({ item, startedAtMs, completedAtMs }) {
  return { ...item, startedAtMs: startedAtMs ?? item.startedAtMs, completedAtMs: completedAtMs ?? item.completedAtMs }
}

/** 线程级条目按写入顺序分页，可以发现追加到已经结束的旧轮次的记录。 */
export async function readItemTailCursor(request, threadId) {
  try {
    const { backwardsCursor } = await request(itemList, { threadId, limit: 1, sortDirection: 'desc' })
    return backwardsCursor ?? null
  } catch (error) {
    if (error instanceof CodexRpcError && [-32600, -32601, -32602].includes(error.code)) return null
    throw error
  }
}

/** 跟随活跃尾部。分页历史通过原生条目锚点读取新增记录和需要刷新的未完成项。 */
export function createHistoryTail(request, thread, initialPage, itemCursor) {
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
    return rows.map(flattenItem)
  }

  async function readLateItems() {
    const latestCursor = await readItemTailCursor(request, threadId)
    if (!latestCursor || latestCursor === itemCursor) return []
    // 先取得新的反向游标，再读取旧游标之后的条目，避免跨过并发写入。
    const rows = itemCursor
      ? await readThrough(request, itemList, { threadId, limit: 100, sortDirection: 'asc' }, itemCursor)
      : []
    itemCursor = latestCursor
    return rows
  }

  return {
    itemCursor: () => itemCursor,
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

      let late = []
      if (paginated) {
        try {
          late = await readLateItems()
        } catch (error) {
          if (error instanceof CodexRpcError && (error.code === -32600 || error.code === -32602)) return null
          throw error
        }
      }
      const changes = []
      const scanned = new Set()
      for (const { items, ...turn } of turns) {
        const previous = seen.get(turn.id)
        const sameTurn = previous && same(previous.turn, turn)
        if (paginated && sameTurn && turn.status !== 'inProgress') continue
        const native = paginated ? await readItems(turn.id, previous) : items
        scanned.add(turn.id)
        const rows = previous?.items ?? new Map()
        const changed = native.filter(item => !same(rows.get(item.id), item))
        if (!sameTurn || changed.length) changes.push({ turn, items: changed })
        for (const item of changed) rows.set(item.id, item)
        seen.set(turn.id, { turn, items: rows })
      }
      const lateByTurn = Map.groupBy(late.filter(({ turnId }) => !scanned.has(turnId)), row => row.turnId)
      for (const [id, appended] of lateByTurn) {
        const previous = seen.get(id)
        const items = appended.map(flattenItem).filter(item => !same(previous?.items.get(item.id), item))
        if (items.length) changes.push({ turn: previous?.turn ?? { id }, items, onlyIfLoaded: true })
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
