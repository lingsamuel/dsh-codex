const locationKey = 'codexFileChanges'

/** 复用 DSH 的轮次数据投影，聚合同一轮次内已成功保存的 Codex 文件改动。 */
export const codexTurnChanges = {
  kind: locationKey,
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/result' && !event.data.message.isError && event.data.meta?.codexFileChanges?.length) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start(_context, { event }) {
    return { turn: event.data.turn, files: new Map() }
  },
  update({ state }, { event }) {
    const files = new Map(state.files)
    for (const change of event.data.meta.codexFileChanges) {
      const existing = files.get(change.path)
      files.set(change.path, { path: change.path, edits: [...existing?.edits ?? [], change] })
    }
    return { ...state, files }
  },
  buildLocationData({ state }, scope) {
    if (scope !== 'turn' || !state?.files.size) return null
    return { kind: 'turn', turn: state.turn, key: locationKey, value: [...state.files.values()] }
  },
}
