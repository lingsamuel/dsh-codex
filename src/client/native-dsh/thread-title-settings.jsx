import { PreferenceRow } from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.tsx'
import css from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.module.css'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import { defaultTitleModel } from '../../shared/thread-title-settings.js'
import { readPage, writeCodexCapability } from '../api.js'

const locale = 'codex.thread-title-settings'
const endpoint = 'title-settings'
const defaultOption = 'default'
const labels = {
  zh: {
    model: '拟标题模型', default: '{model}（默认）', unavailable: '{model}（不可用）',
    modelHelp: '首次和后续拟题会把少量用户发言交给所选提供商单独请求。默认使用 {model}（低推理强度）。模型不可用时保留原标题或正文预览。即使标题没有变化，拟题也可能增加订阅用量或 API 费用。',
    follow: '随会话更新标题',
    followHelp: '每累计两轮含网页发言的对话后检查任务是否变化。新增正文很短时跳过请求，手动起的标题会保留。',
    loading: '正在读取…', retry: '重试', catalogError: '无法读取可用模型。',
  },
  en: {
    model: 'Title generation model', default: '{model} (default)', unavailable: '{model} (unavailable)',
    modelHelp: 'Initial titles and updates send a small amount of user text to the selected provider in a separate request. The default is {model} with low reasoning. If the model is unavailable, the title or message preview stays as is. Requests may use additional plan allowance or incur API costs even when the title stays the same.',
    follow: 'Update titles as the conversation evolves',
    followHelp: 'Check for a task change every two turns with web messages. Skip requests when the new text is very short. Keep manually set titles.',
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

  const models = catalog?.groups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id, label: `${group.name} · ${model.name || model.id}`,
  }))) ?? []
  const modelOptions = new Map(models.map(model => [optionId(model), model]))
  const value = optionId(settings?.selection)
  const defaultLabel = t('default', { model: defaultTitleModel.name })
  const label = value === defaultOption ? defaultLabel : modelOptions.get(value)?.label
    ?? (catalog ? t('unavailable', { model: settings.selection.model }) : settings.selection.model)

  return <>
    <PreferenceRow title={t('model')} description={t('modelHelp', { model: defaultTitleModel.name })}
      value={value} selectedLabel={settings ? label : t('loading')}
      options={settings && !saving ? [{ id: defaultOption, label: defaultLabel }, ...models.map(model => ({
        id: optionId(model), label: model.label,
      }))] : []}
      onSelect={next => {
        if (next === value) return
        void save({ selection: next === defaultOption ? null : modelOptions.get(next) })
      }} />
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('follow')}</div>
        <div id={id} className={css.desc}>{t('followHelp')}</div>
      </div>
      <Switch checked={settings?.follow ?? false} label={t('follow')} describedBy={id}
        disabled={!settings || saving} onChange={follow => void save({ follow })} />
    </div>
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
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'codex-thread-title-settings', order: -17, locale,
    inject: () => ({ ownerSignal, channel }),
  }, ThreadTitleSettings))
}
