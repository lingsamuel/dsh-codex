const turnOutcomes = new Set(['completed', 'failed', 'interrupted'])

/** 连接断开或仅能读取历史时，只展示已有轮次的结果。 */
export function describeLiveStatus({ mode = 'history', status, lastTurnStatus } = {}) {
  const turnOutcome = turnOutcomes.has(lastTurnStatus) ? lastTurnStatus : undefined
  if (mode !== 'live') return { mode, activity: turnOutcome }

  const flags = status?.activeFlags ?? []
  const approval = flags.includes('waitingOnApproval')
  const answer = flags.includes('waitingOnUserInput')
  let activity = turnOutcome
  if (status?.type === 'systemError') activity = 'systemError'
  else if (approval && answer) activity = 'waitingForApprovalAndAnswer'
  else if (approval) activity = 'waitingForApproval'
  else if (answer) activity = 'waitingForAnswer'
  else if (status?.type === 'active' || (!status && lastTurnStatus === 'inProgress')) activity = 'running'
  else if (!turnOutcome && status?.type === 'idle') activity = 'idle'
  return { mode, activity }
}
