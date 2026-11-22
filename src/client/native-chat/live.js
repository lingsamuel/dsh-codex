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

/** 按原生 ID 增量合并已记录的轮次和条目，返回发生变化的轮次。 */
export function createLiveTranscript() {
  const byId = new Map()

  function reconcile(turn, updates = turn.items ?? []) {
    const record = byId.get(turn.id)
    const { items: previousItems = [], ...previous } = record?.turn ?? {}
    const { items: _snapshotItems, ...metadata } = turn
    const next = { status: 'inProgress', ...previous, ...metadata }
    if (isSettled(previous.status) && next.status === 'inProgress') next.status = previous.status
    for (const field of ['startedAt', 'completedAt', 'durationMs', 'rootTurnId']) {
      if (next[field] == null && previous[field] != null) next[field] = previous[field]
    }

    const ids = record?.ids ?? new Map()
    let items = previousItems
    for (const update of updates) {
      const item = nativeItem(update)
      const index = ids.get(item.id)
      if (index !== undefined) {
        const current = items[index]
        if (itemIsOlder(current, item) || JSON.stringify(current) === JSON.stringify(item)) continue
        if (items === previousItems) items = previousItems.slice()
        items[index] = item
      } else {
        if (items === previousItems) items = previousItems.slice()
        ids.set(item.id, items.length)
        items.push(item)
      }
    }
    if (record && items === previousItems && JSON.stringify(next) === JSON.stringify(previous)) return

    const snapshot = { ...next, items }
    byId.set(turn.id, { turn: snapshot, ids })
    return snapshot
  }

  return { reconcile, getTurn: id => byId.get(id)?.turn, forgetTurn: id => byId.delete(id) }
}
