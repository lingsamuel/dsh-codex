function isSettled(status) {
  return status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'declined'
}

function nativeItem(item) {
  if (item.type !== 'reasoning' || !Object.hasOwn(item, 'content')) return item
  const { content, ...publicSummary } = item
  return publicSummary
}

function itemIsOlder(previous, item) {
  return (previous.completedAtMs != null && (item.completedAtMs == null || item.completedAtMs < previous.completedAtMs))
    || (isSettled(previous.status) && item.status === 'inProgress')
}

/** 按原生 ID 合并会话持有的轮次。条目数组随更新复用，变更结果保留被替换的条目及其最早位置。 */
export function createLiveTranscript() {
  const byId = new Map()

  /** 合并原生条目。投影失败时，可在下一次合并前回退本次修改。 */
  function reconcile(turn, updates = turn.items ?? [], prefixIds) {
    const record = byId.get(turn.id)
    const { items = [], ...previous } = record?.turn ?? {}
    const { items: _snapshotItems, ...metadata } = turn
    const next = { status: 'inProgress', ...previous, ...metadata }
    if (isSettled(previous.status) && next.status === 'inProgress') next.status = previous.status
    for (const field of ['startedAt', 'completedAt', 'durationMs', 'rootTurnId']) {
      if (next[field] == null && previous[field] != null) next[field] = previous[field]
    }

    const ids = record?.ids ?? new Map()
    const changes = new Map()
    const originalLength = items.length
    function rollback() {
      for (const [index, previous] of changes) {
        if (index < originalLength) items[index] = previous
        else ids.delete(items[index].id)
      }
      items.length = originalLength
      if (record) byId.set(turn.id, record)
      else byId.delete(turn.id)
    }

    let firstChanged = Infinity
    try {
      for (const update of updates) {
        const item = nativeItem(update)
        const index = ids.get(item.id) ?? items.length
        const current = items[index]
        if (current && (itemIsOlder(current, item) || JSON.stringify(current) === JSON.stringify(item))) continue
        if (!changes.has(index)) changes.set(index, current)
        firstChanged = Math.min(firstChanged, index)
        ids.set(item.id, index)
        items[index] = item
      }
      if (record && !changes.size && !prefixIds && JSON.stringify(next) === JSON.stringify(previous)) return
      // 摘要中的最终答复先于详情到达。以原生详情顺序重排已读前缀，同时保留摘要和实时尾部。
      let orderedItems = items
      let orderedIds = ids
      if (prefixIds) {
        const prefix = new Set(prefixIds)
        orderedItems = [...prefix].map(id => items[ids.get(id)]).concat(items.filter(item => !prefix.has(item.id)))
        orderedIds = new Map(orderedItems.map((item, index) => [item.id, index]))
        const moved = orderedItems.findIndex((item, index) => items[index] !== item)
        if (moved !== -1) firstChanged = Math.min(firstChanged, moved)
      }
      const merged = { ...next, items: orderedItems }
      byId.set(turn.id, { turn: merged, ids: orderedIds })
      return { turn: merged, firstChanged, changes: [...changes].map(([index, previous]) => ({ item: items[index], previous })), rollback }
    } catch (error) {
      rollback()
      throw error
    }
  }

  return { reconcile, getTurn: id => byId.get(id)?.turn, forgetTurn: id => byId.delete(id) }
}
