function findEventIndex(entries, length, seq) {
  let first = 0
  let end = length
  while (first < end) {
    const middle = first + Math.floor((end - first) / 2)
    if (entries[middle].event.seq < seq) first = middle + 1
    else end = middle
  }
  return first
}

/** 在发布时的长度内查询原始事件，避免实时追加时复制已加载历史。 */
export function trajectoryCoordinates(entries, length = entries.length) {
  const first = length > 0 ? entries[0].event : undefined
  return {
    firstTurn: first?.type === 'turn/start' ? first.data.turn : undefined,
    locateTool({ seq, callId }) {
      const index = findEventIndex(entries, length, seq)
      const result = index < length ? entries[index].event : undefined
      if (result?.seq === seq && result.type === 'tool/result' && result.data.message.source.callId === callId) {
        return { turn: result.data.turn, step: result.data.step }
      }
      // DSH 会在所属步骤结束前插入中断结果。沿该轮的原始调用 ID 找回坐标。
      for (let i = index - 1; i >= 0; i--) {
        const event = entries[i].event
        if (event.type === 'turn/start') break
        if (event.type === 'tool/call' && event.data.callId === callId) {
          return { turn: event.data.turn, step: event.data.step }
        }
      }
    },
  }
}

/** 显示顺序以当前历史窗口为起点，事件和折叠继续使用原来的轮次标识。 */
export function trajectoryTurnNumber(firstTurn, turn) {
  if (firstTurn !== undefined && turn >= firstTurn) return turn - firstTurn + 1
}
