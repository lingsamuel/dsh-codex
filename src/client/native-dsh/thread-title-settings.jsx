import { PreferenceRow } from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.tsx'
import css from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.module.css'
import { Button, IconCheckOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import { configuredModelGroup } from '../../shared/model-selection.js'
import { defaultTitleEffort, defaultTitleModel } from '../../shared/thread-title-settings.js'
import { readPage, writeCodexCapability } from '../api.js'
import { codexSettingsItem } from './codex-settings.jsx'

const locale = 'codex.thread-title-settings'
const endpoint = 'title-settings'
const defaultOption = 'default'
const defaultEffortOption = 'effort-default'
const labels = {
  zh: {
    model: '拟标题模型', default: '{model}（默认）', unavailable: '{model}（不可用）',
    modelHelp: '首次拟题和后续更新会把少量用户发言交给所选提供商，并使用这里设置的思考强度。菜单会标明默认档位。模型不可用时保留原标题或正文预览。',
    modelMenu: '模型', effort: '思考强度', effortDefault: '默认（{effort}）',
    costHelp: '即使标题没有变化，拟题也可能增加订阅用量或 API 费用。',
    follow: '随会话更新标题',
    followHelp: '每累计两轮含网页发言的对话后检查任务是否变化。新增正文很短时跳过请求，手动起的标题会保留。',
    showHistory: '在会话历史中显示标题更新',
    showHistoryHelp: '在触发轮次下显示额外的拟题请求和结果。待确认表示请求或结果尚未核实，Token 用量以模型服务计量为准。关闭时仍记录。',
    loading: '正在读取…', retry: '重试', catalogError: '无法读取可用模型。',
  },
  en: {
    model: 'Title generation model', default: '{model} (default)', unavailable: '{model} (unavailable)',
    modelHelp: 'Initial titles and updates send a small amount of user text to the selected provider and use the reasoning effort set here. The menu shows the default level. If the model is unavailable, the title or message preview stays as is.',
    modelMenu: 'Model', effort: 'Reasoning effort', effortDefault: 'Default ({effort})',
    costHelp: 'Requests may use additional plan allowance or incur API costs even when the title stays the same.',
    follow: 'Update titles as the conversation evolves',
    followHelp: 'Check for a task change every two turns with web messages. Skip requests when the new text is very short. Keep manually set titles.',
    showHistory: 'Show title updates in conversation history',
    showHistoryHelp: 'Display extra title requests and their results below the triggering turn. Pending means the request or result has not been verified. Token usage is measured by the model provider. Requests are recorded when this is off.',
    loading: 'Loading…', retry: 'Retry', catalogError: 'Could not load available models.',
  },
}

const optionId = selection => selection ? JSON.stringify([selection.provider, selection.model]) : defaultOption

function ThreadTitleSettings({ t, ownerSignal, channel }) {
  const id = useId()
  const [settings, setSettings] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [catalogError, setCatalogError] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const lifetime = new AbortController()
    const signal = AbortSignal.any([ownerSignal, lifetime.signal])
    let read = 0
    function refresh() {
      const revision = ++read
      void readPage(endpoint, {}, signal).then(result => {
        if (signal.aborted || revision !== read) return
        setSettings(result)
        setLoadError('')
      }).catch(error => { if (!signal.aborted && revision === read) setLoadError(error.message) })
    }
    refresh()
    channel.addEventListener('message', refresh, { signal })
    void readPage('models', {}, signal).then(result => {
      if (signal.aborted) return
      setCatalog(result)
      setCatalogError(false)
    }).catch(() => { if (!signal.aborted) setCatalogError(true) })
    return () => lifetime.abort()
  }, [ownerSignal, channel, attempt])

  async function save(patch) {
    if (!settings || saving) return
    setSaving(true)
    setSaveError('')
    try {
      const result = await writeCodexCapability(endpoint, patch, ownerSignal)
      if (ownerSignal.aborted) return
      setSettings(result)
      channel.postMessage(null)
    } catch (error) {
      if (!ownerSignal.aborted) setSaveError(error.message)
    } finally {
      setSaving(false)
    }
  }

  const group = configuredModelGroup(catalog)
  const models = group?.models.map(model => ({ provider: group.id, model: model.id, label: model.name || model.id })) ?? []
  const modelOptions = new Map(models.map(model => [optionId(model), model]))
  const selection = settings?.selection
  const explicitModel = selection?.model ? { provider: selection.provider, model: selection.model } : null
  const activeModel = explicitModel ?? defaultTitleModel
  const value = optionId(explicitModel)
  const defaultLabel = t('default', { model: defaultTitleModel.name })
  const selectedProvider = catalog?.groups.find(candidate => candidate.id === activeModel.provider)
  const selectedModel = selectedProvider?.models.find(model => model.id === activeModel.model)
  const label = value === defaultOption ? defaultLabel : modelOptions.get(value)?.label
    ?? (selectedModel ? `${selectedProvider.name} · ${selectedModel.name || activeModel.model}`
      : catalog ? t('unavailable', { model: activeModel.model }) : activeModel.model)
  const efforts = selectedModel?.reasoning?.efforts ?? []
  const selectedEffort = efforts.find(level => level.id === selection?.reasoningEffort)
  const defaultEffort = defaultTitleEffort(activeModel, selectedModel?.reasoning)
  const effortLabel = selectedEffort?.name ?? defaultEffort
  const effortOptions = defaultEffort ? [
    { id: defaultEffortOption, label: t('effortDefault', { effort: defaultEffort }) },
    ...efforts.map(level => ({ id: `effort:${level.id}`, label: level.name, effort: level.id })),
  ] : []
  const modelChoices = [{ id: defaultOption, label: defaultLabel }, ...models.map(model => ({ id: optionId(model), label: model.label }))]
  const options = [{ id: 'model', label: `${t('modelMenu')} · ${label}`,
    submenu: modelChoices.map(option => ({ ...option,
      icon: option.id === value ? <IconCheckOutlineRegular size={14} /> : undefined,
    })),
  }]
  if (effortOptions.length) options.push({
    id: 'effort', label: `${t('effort')} · ${effortLabel}`,
    submenu: effortOptions.map(option => ({ ...option,
      icon: option.effort === selectedEffort?.id ? <IconCheckOutlineRegular size={14} /> : undefined,
    })),
  })

  function select(next) {
    if (next === value) return
    if (next === defaultOption) {
      void save({ selection: null })
      return
    }
    const model = modelOptions.get(next)
    if (model) {
      void save({ selection: { provider: model.provider, model: model.model } })
      return
    }
    const option = effortOptions.find(choice => choice.id === next)
    if (option && option.effort !== selection?.reasoningEffort) {
      void save({ selection: option.effort === undefined ? explicitModel : { ...explicitModel, reasoningEffort: option.effort } })
    }
  }

  return <>
    <PreferenceRow title={t('model')} description={<>{t('modelHelp')}<br />{t('costHelp')}</>}
      value={value} selectedLabel={settings ? (effortLabel ? `${label} · ${effortLabel}` : label) : t('loading')}
      options={settings && !saving ? options : []} onSelect={select} />
    {['follow', 'showHistory'].map(field => <div className={css.row} key={field}>
      <div className={css.rowText}>
        <div className={css.title}>{t(field)}</div>
        <div id={`${id}-${field}`} className={css.desc}>{t(`${field}Help`)}</div>
      </div>
      <Switch checked={settings?.[field] ?? false} label={t(field)} describedBy={`${id}-${field}`}
        disabled={!settings || saving} onChange={value => void save({ [field]: value })} />
    </div>)}
    {(loadError || catalogError || saveError) && <div role="alert" className={css.desc}>
      {saveError || loadError || t('catalogError')}
      {(loadError || catalogError) && <Button size="sm" variant="outline"
        onClick={() => setAttempt(previous => previous + 1)}>{t('retry')}</Button>}
    </div>}
  </>
}

/** 注册独立的拟题模型与更新开关，页面间通过同源通知重新读取 Host 偏好。 */
export function installThreadTitleSettings(ctx, ownerSignal) {
  const channel = new BroadcastChannel(locale)
  ctx.effect(() => () => channel.close())
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject(codexSettingsItem, () => ctx.slots.register({
    name: codexSettingsItem, id: 'codex-thread-title-settings', order: -17, locale,
    inject: () => ({ ownerSignal, channel }),
  }, ThreadTitleSettings))
}
