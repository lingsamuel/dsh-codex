import { CodexRpcError, iterateCodexPages } from './app-server.mjs'

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
  return left === right || (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right))
}

function needsUpdate(item) {
  if (item.status === 'inProgress') return true
  return item.completedAtMs == null && ['agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(item.type)
}

function readThrough(request, method, parameters, cursor) {
  return iterateCodexPages(next => request(method, { ...parameters, ...(next != null && { cursor: next }) }), cursor)
}

export function flattenHistoryItem({ item, startedAtMs, completedAtMs }) {
  return { ...item, startedAtMs: startedAtMs ?? item.startedAtMs, completedAtMs: completedAtMs ?? item.completedAtMs }
}

export async function readHistoryItemsById(request, threadId, turnId, itemIds) {
  const result = await request('thread/items/read', { threadId, turnId, itemIds })
  return { data: result.data.map(flattenHistoryItem) }
}

function invalidHistoryCursor(error) {
  return error instanceof CodexRpcError && (error.code === -32600 || error.code === -32602)
}

/** 线程级倒序页返回续读位置及其包含的原生锚点。 */
export async function readItemTail(request, threadId) {
  try {
    const { data, backwardsCursor } = await request(itemList, { threadId, limit: 1, sortDirection: 'desc' })
    const { item, turnId } = data?.[0] ?? {}
    return { cursor: backwardsCursor ?? null, itemId: item?.id, turnId }
  } catch (error) {
    if (error instanceof CodexRpcError && [-32600, -32601, -32602].includes(error.code)) return null
    throw error
  }
}

/** 跟随活跃尾部。分页历史通过原生条目锚点读取新增记录和需要刷新的未完成项。 */
export function createHistoryTail(request, thread, initialPage, itemCursor, itemAnchor) {
  const threadId = thread.id
  const paginated = thread.historyMode === 'paginated'
  const itemsView = paginated ? 'notLoaded' : 'full'
  const seen = new Map()
  for (const { items = [], itemsView, ...turn } of initialPage.data) {
    seen.set(turn.id, { turn, items: new Map(items.map(item => [item.id, item])), partial: itemsView === 'summary' })
  }
  let lastTurnId = initialPage.data[0]?.id
  let tailCursor = initialPage.backwardsCursor

  function readItems(turnId, known) {
    let anchor
    for (const item of known.values()) {
      if (needsUpdate(item)) break
      anchor = item
    }
    return readThrough(request, itemList, { threadId, turnId, limit: 100, sortDirection: 'asc' },
      anchor ? { type: 'item', itemId: anchor.id } : null)
  }

  async function deliverTurn({ items = [], itemsView: _view, ...turn }, consume, scanned, isCurrent) {
    const previous = seen.get(turn.id)
    const sameTurn = previous && same(previous.turn, turn)
    if (paginated && sameTurn && turn.status !== 'inProgress') return true
    const rows = previous?.items ?? new Map()
    if (paginated && previous?.partial) {
      // 摘要不是连续前缀。从线程级检查点交付新条目，仅点读已知且尚会变化的记录。
      const itemIds = [...rows.values()].filter(item => !item.historyPreview && needsUpdate(item)).slice(-100).map(item => item.id)
      const result = itemIds.length ? await readHistoryItemsById(request, threadId, turn.id, itemIds).catch(error => {
        if (error instanceof CodexRpcError && [-32600, -32601, -32602].includes(error.code)) return null
        throw error
      }) : null
      if (!isCurrent()) return false
      const changed = (result?.data ?? []).filter(item => !same(rows.get(item.id), item))
      if ((changed.length || !sameTurn) && await consume({ turn, items: changed }, true) === false) return false
      for (const item of changed) rows.set(item.id, item)
      seen.set(turn.id, { ...previous, turn })
      return true
    }
    const pages = paginated ? readItems(turn.id, rows) : [{ data: items }]
    try {
      for await (const { data, nextCursor } of pages) {
        if (!isCurrent()) return false
        const changed = []
        for (const entry of data) {
          const item = paginated ? flattenHistoryItem(entry) : entry
          if (same(rows.get(item.id), item)) continue
          rows.set(item.id, item)
          changed.push(item)
        }
        const lastPage = !nextCursor
        if ((changed.length || (lastPage && !sameTurn))
          && await consume({ turn, items: changed }, lastPage) === false) return false
      }
    } catch (error) {
      if (paginated && invalidHistoryCursor(error)) return false
      throw error
    }
    scanned.add(turn.id)
    seen.set(turn.id, { turn, items: rows })
    return true
  }

  async function deliverLateItems(consume, scanned, head, isCurrent) {
    const pages = readThrough(request, itemList, { threadId, limit: 100, sortDirection: 'asc' }, itemCursor)
    const { itemId, turnId: lastTurn } = head
    const hasBoundary = itemId != null && lastTurn != null
    try {
      for await (const { data } of pages) {
        if (!isCurrent()) return false
        // 范围起点是原生不透明游标，终点按捕获的条目辨认，避免追着并发追加无限补页。
        const boundary = hasBoundary ? data.findIndex(row => row.turnId === lastTurn && row.item.id === itemId) : -1
        const included = boundary < 0 ? data : data.slice(0, boundary + 1)
        const byTurn = Map.groupBy(included.filter(row => !scanned.has(row.turnId)), row => row.turnId)
        for (const [id, appended] of byTurn) {
          const previous = seen.get(id)
          const items = appended.map(flattenHistoryItem).filter(item => {
            const known = previous?.items.get(item.id)
            if (previous?.partial && !known && itemAnchor?.turnId === id && itemAnchor.itemId === item.id) return false
            return !same(known, item)
          })
          if (items.length && await consume({ turn: previous?.turn ?? { id }, items, onlyIfLoaded: true }, true) === false) return false
          if (previous?.partial && previous.turn.status === 'inProgress') {
            for (const item of items) if (needsUpdate(item)) previous.items.set(item.id, item)
          }
        }
        if (boundary >= 0) return true
      }
    } catch (error) {
      if (invalidHistoryCursor(error)) return false
      throw error
    }
    // 有明确终点却未读到时，原范围可能已被回退或替换。
    return !hasBoundary
  }

  /** 回调成功交付当前页后才继续。返回 false 时丢弃此尾部并发送替换快照。 */
  async function readChanges(consume, isCurrent = () => true) {
    const head = await readThreadTurns(request, { threadId, limit: 1, sortDirection: 'desc', itemsView })
    const latest = head.data[0]
    if (!isCurrent()) return false
    if (!latest) return !lastTurnId
    if (latest.id !== lastTurnId && seen.has(latest.id)) return false
    // 普通轮次读取前固定条目游标上界。较晚的写入仍可在下一次检查中读到。
    const latestItem = paginated ? await readItemTail(request, threadId) : null
    if (!isCurrent()) return false
    const pages = latest.id === lastTurnId ? [{ data: [latest] }]
      : readThrough(request, turnList, { threadId, limit: 100, sortDirection: 'asc', itemsView }, tailCursor)
    const scanned = new Set()
    let foundLatest = false
    try {
      for await (const { data } of pages) {
        if (!isCurrent()) return false
        for (const turn of data) {
          if (!isCurrent() || !await deliverTurn(turn, consume, scanned, isCurrent)) return false
          if (turn.id === latest.id) {
            foundLatest = true
            break
          }
          if (scanned.has(turn.id) && turn.status !== 'inProgress') seen.get(turn.id).items.clear()
        }
        if (foundLatest) break
      }
    } catch (error) {
      // 原生已发出的轮次游标变为无效，通常是回退删去了它的锚点。
      if (tailCursor && invalidHistoryCursor(error)) return false
      throw error
    }
    if (!foundLatest || !isCurrent()) return false
    const latestCursor = latestItem?.cursor
    if (itemCursor && latestCursor && latestCursor !== itemCursor
      && !await deliverLateItems(consume, scanned, latestItem, isCurrent)) return false
    if (!isCurrent()) return false

    // 较早的轮次只保留状态，用于辨认游标重复出现的锚点。
    for (const [id, view] of seen) {
      if (id !== latest.id && view.turn.status !== 'inProgress') view.items.clear()
    }
    lastTurnId = latest.id
    tailCursor = head.backwardsCursor
    if (latestCursor) {
      itemCursor = latestCursor
      itemAnchor = latestItem
    }
    return true
  }

  return {
    itemCursor: () => itemCursor,
    partialTurns: () => paginated ? [...seen].filter(([, view]) => view.partial).map(([id]) => id) : [],
    readChanges,
  }
}
