import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpcError, readCodexPages, withCodexReader } from './app-server.mjs'
import { modelSelectionOf } from '../shared/model-selection.js'

/** 目录和模型核对均沿用同一提供商的原生分页与可见性规则。 */
export async function readVisibleProviderModels(request, provider) {
  const rows = await readCodexPages(cursor => request('model/list', {
    modelProvider: provider, limit: 100, ...(cursor != null && { cursor }),
  }))
  return rows.filter(model => !model.hidden)
}

/** 目录和依目录执行的拟标题使用相同的模型与档位表示。 */
export function codexModelOption(model) {
  return {
    id: model.model,
    name: model.displayName,
    description: model.description,
    reasoning: model.supportedReasoningEfforts?.length ? {
      defaultEffort: model.defaultReasoningEffort,
      efforts: model.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({
        id: reasoningEffort, name: reasoningEffort, description,
      })),
    } : undefined,
  }
}

/** 用 Codex 各 provider 自己的模型列表为 DSH 选择器供应可用等级。 */
export async function readModelCatalog(request, cwd) {
  const [{ data: providers, defaultProviderId }, settings] = await Promise.all([
    request('modelProvider/list', {}),
    request('config/read', { ...(cwd && { cwd }), includeLayers: false }).catch(error => {
      if (error instanceof CodexRpcError && error.code === -32601) return null
      throw error
    }),
  ])
  const config = settings?.config
  const catalogs = await Promise.all(providers.map(async ({ id, name }) => {
    try {
      const visible = await readVisibleProviderModels(request, id)
      return {
        group: { id, name, models: visible.map(codexModelOption) },
        defaultModel: visible.find(model => model.isDefault) ?? visible[0],
      }
    } catch (error) {
      return { failure: { id, name, message: error.message } }
    }
  }))
  const groups = catalogs.flatMap(({ group }) => group?.models.length ? [group] : [])
  const failures = catalogs.flatMap(({ failure }) => failure ? [failure] : [])
  const provider = config?.model_provider ?? defaultProviderId
  const defaultCatalog = catalogs.find(value => value.group?.id === provider && value.defaultModel)
    ?? catalogs.find(value => value.defaultModel)
  if (!defaultCatalog) throw new Error(failures[0]?.message ?? 'Codex 暂未返回可用模型。')
  const model = config?.model ?? defaultCatalog.defaultModel.model
  const modelProvider = config?.model ? provider ?? defaultCatalog.group.id : defaultCatalog.group.id
  const modelInfo = groups.find(group => group.id === modelProvider)?.models.find(option => option.id === model)
  return {
    default: modelSelectionOf({ modelProvider, model,
      reasoningEffort: config?.model_reasoning_effort ?? modelInfo?.reasoning?.defaultEffort }),
    groups, failures, routableProviders: groups.map(group => group.id),
  }
}

function unavailable(message) {
  return new CodexRpcError({ code: -32600, message, data: { reason: 'modelSelectionUnavailable' } })
}

/** 校验提交模型。已有线程必须保持原生 provider，新线程使用提交的 provider。 */
export function validateModelDraft(thread, draft) {
  if (draft === undefined) return
  if (!draft || typeof draft.provider !== 'string' || !draft.provider.trim()
    || typeof draft.model !== 'string' || !draft.model.trim()
    || (draft.reasoningEffort !== undefined && typeof draft.reasoningEffort !== 'string')) {
    throw new CodexRpcError({ code: -32602, message: '无效的草稿模型设置。' })
  }
  if (thread && thread.modelProvider !== draft.provider) throw unavailable('会话的模型提供商已变化。')
}

/** 保存网页新会话的默认设置。仅覆盖强度时以 Codex 当前模型核对可用档位。 */
export function createModelDefaultRoute(socketPath, ownerSignal, preference) {
  function json(body, status = 200) {
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  }
  return {
    path: '/api/codex/model-default', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'POST' && request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return json({ error: '只接受 JSON 请求。' }, 415)
      }
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      try {
        if (request.method === 'GET') return json({ selection: await preference.get() })
        const { selection } = (await request.json().catch(() => null)) ?? {}
        if (selection === undefined) return json({ error: '缺少默认模型设置。' }, 400)
        let selected = null
        if (selection !== null) {
          const effortOnly = selection.model === undefined && selection.provider === undefined && typeof selection.reasoningEffort === 'string'
          if (!effortOnly) validateModelDraft(undefined, selection)
          const { groups, default: native } = await withCodexReader(socketPath, signal, readModelCatalog)
          const { provider, model } = effortOnly ? native : selection
          const { reasoningEffort } = selection
          const option = groups.find(group => group.id === provider)?.models.find(value => value.id === model)
          if (!option || (reasoningEffort !== undefined && !option.reasoning?.efforts.some(effort => effort.id === reasoningEffort))) {
            return json({ error: '所选默认模型或思考强度不在 Codex 目录中。' }, 400)
          }
          selected = effortOnly ? { reasoningEffort }
            : modelSelectionOf({ modelProvider: provider, model, reasoningEffort: reasoningEffort ?? option.reasoning?.defaultEffort })
        }
        signal.throwIfAborted()
        await preference.set(selected)
        return json({ selection: selected })
      } catch (error) {
        if (error instanceof CodexRpcError) return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        return json({ error: '无法读取或保存默认模型设置。' }, 503)
      }
    },
  }
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
