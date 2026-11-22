/** 将 Codex 的当前线程设置映射为 DSH 的模型选择，不回填历史请求。 */
export function modelSelectionOf({ modelProvider, model, reasoningEffort }) {
  if (!modelProvider || !model) return null
  return { provider: modelProvider, model, ...(reasoningEffort != null && { reasoningEffort }) }
}
