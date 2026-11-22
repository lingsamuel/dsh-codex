/** Codex 报告的是目标累计运行时间，可能跨越多轮。 */
export function goalCompletion(goal) {
  const { status, timeUsedSeconds } = goal ?? {}
  if (status === 'complete' && Number.isFinite(timeUsedSeconds) && timeUsedSeconds >= 0) return { timeUsedSeconds }
}
