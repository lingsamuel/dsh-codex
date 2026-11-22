const exceptionalOutcomes = new Set(['failed', 'interrupted'])

/** 在独立 Profile 内沿用 DSH 的状态源，用 Codex 回执取代本地完成推断。 */
export function installUnreadStatus(status, catalog) {
  // 当前 DSH 把同一对象给侧栏和搜索，根 Hook 不允许同名注册。
  const { getSnapshot, subscribe } = status
  let previousStatus
  let previousUnread
  let snapshot
  status.getSnapshot = () => {
    const base = getSnapshot()
    const { unreadIds } = catalog.getSnapshot()
    if (previousStatus === base && previousUnread === unreadIds) return snapshot
    previousStatus = base
    previousUnread = unreadIds
    const unread = new Set(unreadIds)
    snapshot = new Map()
    for (const [id, value] of base) {
      const completionUnread = unread.delete(id)
      snapshot.set(id, completionUnread === value.completionUnread ? value : { ...value, completionUnread })
    }
    for (const id of unread) snapshot.set(id, { completionUnread: true })
    return snapshot
  }
  status.subscribe = listener => {
    const releaseStatus = subscribe(listener)
    const releaseCatalog = catalog.subscribe(listener)
    return () => {
      releaseCatalog()
      releaseStatus()
    }
  }
  return () => Object.assign(status, { getSnapshot, subscribe })
}

/** 只在标题栏补充 DSH 侧栏状态点没有表达的连接和异常信息。 */
export function describeLiveStatus({ mode = 'history', status, lastTurnStatus } = {}) {
  const turnOutcome = exceptionalOutcomes.has(lastTurnStatus) ? lastTurnStatus : undefined
  if (mode !== 'live') return { mode, activity: turnOutcome }
  if (status?.type === 'systemError') return { activity: 'systemError' }
  return { mode: undefined, activity: status?.type === 'active' ? undefined : turnOutcome }
}

/** 向 DSH 发布 Codex 的等待标记。Codex 保留实际请求，释放标记无需替用户处理。 */
export function publishPendingStatus(catalog, publish) {
  const published = new Map()
  let sequence = 0

  function sync() {
    const pending = new Map()
    for (const { id, status } of catalog.getSnapshot().threads) {
      if (status?.type !== 'active') continue
      // 沿用 DSH 问答优先于审批的顺序。Codex 全局状态只提供类型，不提供可回复的请求。
      if (status.activeFlags?.includes('waitingOnUserInput')) pending.set(id, 'question')
      else if (status.activeFlags?.includes('waitingOnApproval')) pending.set(id, 'approval')
    }
    for (const [id, { kind, remove }] of published) {
      if (pending.get(id) === kind) continue
      remove()
      published.delete(id)
    }
    for (const [sessionId, kind] of pending) {
      if (published.has(sessionId)) continue
      const remove = publish({ sessionId, kind, key: `codex-status:${++sequence}` }, async () => {})
      published.set(sessionId, { kind, remove })
    }
  }

  const unsubscribe = catalog.subscribe(sync)
  sync()
  return () => {
    unsubscribe()
    for (const { remove } of published.values()) remove()
  }
}
