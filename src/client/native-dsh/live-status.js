const exceptionalOutcomes = new Set(['failed', 'interrupted'])

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
