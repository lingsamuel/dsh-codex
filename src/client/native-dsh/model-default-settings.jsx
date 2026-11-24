import { PreferenceRow } from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.tsx'
import { useEffect, useState } from 'react'
import { configuredModelGroup } from '../../shared/model-selection.js'
import { modelDefaultChanged, readPage, writeModelDefault } from '../api.js'
import { codexSettingsItem } from './codex-settings.jsx'

const locale = 'codex.model-default'
const followCodex = 'follow-codex'
const retry = 'retry'
const labels = {
  zh: {
    model: '新会话默认模型', modelDescription: '用于此 DSH Profile 新建的 Codex 会话。',
    effort: '新会话思考强度', effortDescription: '可用档位由新会话的默认模型决定。',
    follow: '跟随 Codex', following: '跟随 Codex · {value}', loading: '正在读取…',
    retry: '重试', unavailable: '当前模型未提供思考强度选项。',
  },
  en: {
    model: 'Default model for new sessions', modelDescription: 'Applies to new Codex sessions created in this DSH profile.',
    effort: 'Reasoning effort for new sessions', effortDescription: 'Available levels depend on the default model.',
    follow: 'Follow Codex', following: 'Follow Codex · {value}', loading: 'Loading…',
    retry: 'Retry', unavailable: 'The current model does not advertise reasoning effort levels.',
  },
}

function ModelDefaultSettings({ t, load, save }) {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [writeError, setWriteError] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let revision = 0
    function refresh() {
      const read = ++revision
      void load(signal).then(result => {
        if (signal.aborted || revision !== read) return
        setData(result)
        setLoadError('')
      }).catch(error => { if (!signal.aborted && revision === read) setLoadError(error.message) })
    }
    window.addEventListener(modelDefaultChanged, refresh, { signal })
    refresh()
    return () => controller.abort()
  }, [load, attempt])

  const { catalog, saved } = data ?? {}
  const native = catalog?.default
  const provider = configuredModelGroup(catalog)
  const models = provider?.models ?? []
  const nativeModel = models.find(model => model.id === native?.model)
  const selectedModel = saved?.model ? catalog.groups.find(group => group.id === saved.provider)
    ?.models.find(model => model.id === saved.model) : nativeModel
  const modelValue = !saved?.model ? followCodex
    : saved.provider === provider?.id ? `model:${saved.model}` : `saved:${saved.model}`
  const modelFollowLabel = native?.model ? t('following', { value: nativeModel?.name ?? native.model }) : t('follow')
  const modelLabel = saved?.model ? selectedModel?.name ?? saved.model : modelFollowLabel
  const efforts = selectedModel?.reasoning?.efforts ?? []
  const effortValue = saved?.reasoningEffort ?? followCodex
  const effortLabel = saved?.reasoningEffort ?? (native?.reasoningEffort
    ? t('following', { value: native.reasoningEffort }) : t('follow'))
  const follow = { id: followCodex, label: t('follow') }
  const modelOptions = [{ id: followCodex, label: modelFollowLabel }, ...models.map(model => ({ id: `model:${model.id}`, label: model.name }))]
  const effortOptions = [...(!saved?.model ? [follow] : []), ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]

  async function apply(selection) {
    setSaving(true)
    setWriteError('')
    try {
      const result = await save(selection)
      setData(current => ({ ...current, saved: result.selection }))
    } catch (error) {
      setWriteError(error.message)
    } finally {
      setSaving(false)
    }
  }

  function selectModel(id) {
    if (id === retry) { setAttempt(value => value + 1); return }
    if (!data || saving || id === modelValue) return
    if (id === followCodex) {
      const reasoningEffort = saved?.reasoningEffort
      const nativeEfforts = nativeModel?.reasoning?.efforts
      void apply(nativeEfforts?.some(level => level.id === reasoningEffort) ? { reasoningEffort } : null)
    } else {
      const model = models.find(option => `model:${option.id}` === id)
      if (model) void apply({ provider: provider.id, model: model.id, reasoningEffort: model.reasoning?.defaultEffort })
    }
  }

  function selectEffort(id) {
    if (!data || saving || id === effortValue) return
    if (id === followCodex) void apply(null)
    else void apply({ ...(saved?.model && { provider: saved.provider, model: saved.model }), reasoningEffort: id })
  }

  return <>
    <PreferenceRow title={t('model')} description={writeError || loadError || t('modelDescription')}
      value={modelValue} selectedLabel={data ? modelLabel : t(loadError ? 'retry' : 'loading')}
      options={data ? modelOptions : loadError ? [{ id: retry, label: t('retry') }] : []} onSelect={selectModel} />
    <PreferenceRow title={t('effort')} description={data && !efforts.length ? t('unavailable') : t('effortDescription')}
      value={effortValue} selectedLabel={data ? effortLabel : t('loading')}
      options={data ? effortOptions : []} onSelect={selectEffort} />
  </>
}

/** 通知同源标签页重读 Host 中保存的 Profile 默认值。 */
export function installModelDefaultSettings(ctx, signal) {
  const channel = new BroadcastChannel(modelDefaultChanged)
  const refresh = () => window.dispatchEvent(new Event(modelDefaultChanged))
  channel.addEventListener('message', refresh)
  const controls = {
    async load(localSignal) {
      const requestSignal = AbortSignal.any([signal, localSignal])
      const [{ selection: saved }, catalog] = await Promise.all([
        readPage('model-default', {}, requestSignal), readPage('models', {}, requestSignal),
      ])
      return { saved, catalog }
    },
    async save(selection) {
      const result = await writeModelDefault(selection, signal)
      if (!signal.aborted) {
        refresh()
        channel.postMessage(null)
      }
      return result
    },
  }
  ctx.effect(() => () => channel.close())
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject(codexSettingsItem, () => ctx.slots.register({
    name: codexSettingsItem, id: 'codex-model-default', order: -19, locale, inject: () => controls,
  }, ModelDefaultSettings))
}
