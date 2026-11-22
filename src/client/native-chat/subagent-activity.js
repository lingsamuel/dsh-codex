export const subagentActivityEvent = 'codex/subagent-activity'
export const subagentActivityKinds = ['started', 'completed', 'interrupted']

const kind = 'codex-subagent-activity'

/** 活动保持在原生条目的位置，随 DSH 工作过程收起和展开。 */
export const codexSubagentActivity = {
  kind,
  target: 'chat',
  match(event) {
    return event.type === subagentActivityEvent ? { id: event.data.id, role: 'start' } : null
  },
  start(_context, { event }) {
    return event.data
  },
  update({ state }) {
    return state
  },
  buildViewNode({ key, id, start, state }) {
    if (!start) return null
    return {
      key, id, kind, target: 'chat', anchorSeq: start.event.seq, location: start.location,
      visibility: 'visible', groupTree: 'process', data: state,
    }
  },
}
