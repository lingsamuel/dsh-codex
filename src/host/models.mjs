import { CodexRpcError, readCodexPages } from './app-server.mjs'
import { modelSelectionOf } from '../shared/model-selection.js'

/** 用 Codex 各 provider 自己的模型列表为 DSH 选择器供应可用等级。 */
export async function readModelCatalog(request) {
  const { data: providers, defaultProviderId } = await request('modelProvider/list', {})
  const catalogs = await Promise.all(providers.map(async ({ id, name }) => {
    try {
      const rows = await readCodexPages(cursor => request('model/list', {
        modelProvider: id, limit: 100, ...(cursor != null && { cursor }),
      }))
      const visible = rows.filter(model => !model.hidden)
      return {
        group: { id, name, models: visible.map(model => ({
          id: model.model,
          name: model.displayName,
          description: model.description,
          reasoning: model.supportedReasoningEfforts?.length ? {
            defaultEffort: model.defaultReasoningEffort,
            efforts: model.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({
              id: reasoningEffort, name: reasoningEffort, description,
            })),
          } : undefined,
        })) },
        defaultModel: visible.find(model => model.isDefault) ?? visible[0],
      }
    } catch (error) {
      return { failure: { id, name, message: error.message } }
    }
  }))
  const groups = catalogs.flatMap(({ group }) => group?.models.length ? [group] : [])
  const failures = catalogs.flatMap(({ failure }) => failure ? [failure] : [])
  const defaultCatalog = catalogs.find(value => value.group?.id === defaultProviderId && value.defaultModel)
    ?? catalogs.find(value => value.defaultModel)
  if (!defaultCatalog) throw new Error(failures[0]?.message ?? 'Codex 暂未返回可用模型。')
  return {
    default: modelSelectionOf({ modelProvider: defaultCatalog.group.id, model: defaultCatalog.defaultModel.model,
      reasoningEffort: defaultCatalog.defaultModel.defaultReasoningEffort }),
    groups, failures, routableProviders: groups.map(group => group.id),
  }
}

/** 更新后续轮次的选择。加载由明确的继续会话操作触发。 */
export async function updateModelSelection(request, { threadId, provider, model, reasoningEffort }) {
  const { thread } = await request('thread/read', { threadId })
  if (thread.status?.type === 'notLoaded' || thread.canAcceptDirectInput === false || thread.modelProvider !== provider) {
    const message = thread.modelProvider !== provider ? '会话的模型提供商已变化。'
      : '请先继续此 Codex 会话，再选择模型。'
    throw new CodexRpcError({ code: -32600, message, data: { reason: 'modelSelectionUnavailable' } })
  }
  await request('thread/settings/update', { threadId, model, ...(reasoningEffort && { effort: reasoningEffort }) })
  const updated = await request('thread/read', { threadId }).catch(() => null)
  const selection = updated && modelSelectionOf(updated.thread)
  // 某些版本先确认排队。只有读回已应用的设置才在响应中带回选择，之后由原生流更新。
  if (selection?.provider === provider && selection.model === model
    && (!reasoningEffort || selection.reasoningEffort === reasoningEffort)) return { selection }
  return {}
}
