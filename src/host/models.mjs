import { setTimeout as delay } from 'node:timers/promises'
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

function unavailable(message) {
  return new CodexRpcError({ code: -32600, message, data: { reason: 'modelSelectionUnavailable' } })
}

/** 提交前核对草稿仍属于会话的 provider，避免因为过期的选择恢复会话。 */
export function validateModelDraft(thread, draft) {
  if (draft === undefined) return
  if (!draft || typeof draft.provider !== 'string' || !draft.provider.trim()
    || typeof draft.model !== 'string' || !draft.model.trim()
    || (draft.reasoningEffort !== undefined && typeof draft.reasoningEffort !== 'string')) {
    throw new CodexRpcError({ code: -32602, message: '无效的草稿模型设置。' })
  }
  if (thread.modelProvider !== draft.provider) throw unavailable('会话的模型提供商已变化。')
}

/** 已加载会话直接应用设置。随消息提交时，等原生确认后再允许发送。 */
export async function updateModelSelection(request, { threadId, provider, model, reasoningEffort }, signal) {
  const { thread } = await request('thread/read', { threadId })
  validateModelDraft(thread, { provider, model, reasoningEffort })
  if (thread.status?.type === 'notLoaded' || thread.canAcceptDirectInput === false || thread.archived) {
    throw unavailable('此会话当前无法保存模型设置。')
  }
  const matches = selection => selection?.provider === provider && selection.model === model
    && (!reasoningEffort || selection.reasoningEffort === reasoningEffort)
  const previous = modelSelectionOf(thread)
  if (signal && matches(previous)) return { selection: previous }

  await request('thread/settings/update', { threadId, model, ...(reasoningEffort && { effort: reasoningEffort }) })
  // 某些版本先确认排队。等待草稿设置生效时，不能用旧设置开始下一轮。
  const deadline = performance.now() + 2_000
  do {
    const updated = await request('thread/read', { threadId }).catch(() => null)
    const selection = updated && modelSelectionOf(updated.thread)
    if (matches(selection)) return { selection }
    if (!signal) return {}
    if (!updated || updated.thread.status?.type === 'notLoaded') break
    await delay(50, undefined, { signal })
  } while (performance.now() < deadline)
  throw unavailable('Codex 尚未确认草稿的模型设置，消息未提交。')
}
