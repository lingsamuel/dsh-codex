export const defaultTitleModel = { provider: 'openai', model: 'gpt-6-luna', name: 'GPT-6 Luna' }

/** 设置显示与拟标题请求共用同一默认档位，所有候选都来自模型目录。 */
export function defaultTitleEffort({ provider, model }, reasoning) {
  const efforts = reasoning?.efforts
  if (!efforts?.length) return
  // Luna 保留拟标题的 Low 默认值。目录撤下 Low 时，沿用新的可用档位。
  if (provider === defaultTitleModel.provider && model === defaultTitleModel.model
    && efforts.some(level => level.id === 'low')) return 'low'
  return efforts.find(level => level.id === reasoning.defaultEffort)?.id ?? efforts[0].id
}
