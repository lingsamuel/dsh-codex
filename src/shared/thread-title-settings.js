export const defaultTitleModel = { provider: 'openai', model: 'gpt-6-luna', name: 'GPT-6 Luna' }

/** 拟题未指定档位时，仅内置标题模型覆盖 Codex 的推理强度。 */
export function defaultTitleEffort({ provider, model }) {
  if (provider === defaultTitleModel.provider && model === defaultTitleModel.model) return 'low'
}
