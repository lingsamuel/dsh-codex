import { Button, SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import { historyPreferenceLimits, isHistoryPreferenceValue } from '../../shared/history-preferences.js'
import { readPage, writeCodexCapability } from '../api.js'

const locale = 'codex.history-preferences'
const endpoint = 'history-preferences'
const numericFields = Object.keys(historyPreferenceLimits)
const labels = {
  zh: {
    title: 'Codex 会话历史加载', description: '保存后在下次打开会话时生效。',
    firstItems: '首屏条目数预算', firstMiB: '首屏体积预算（MiB）',
    openTurns: '打开时加载轮数', manualTurns: '每次加载更早的轮数', prefetch: '后台预读',
    prefetchHint: '首屏显示后，自动向前加载直到达到打开时的目标轮数。',
    invalidCount: '请输入正整数。', invalidMiB: '请输入大于零的 MiB 数值。',
    invalidOpen: '请输入至少为 3 的整数。',
    loading: '正在读取…', retry: '重试', loadFailed: '无法读取会话历史设置。',
    save: '保存', saving: '保存中…', saveFailed: '无法保存会话历史设置。修改已保留，请重试。',
  },
  en: {
    title: 'Codex session history loading', description: 'Saved settings apply the next time you open a session.',
    firstItems: 'Initial item budget', firstMiB: 'Initial size budget (MiB)',
    openTurns: 'Turns to load on open', manualTurns: 'Turns per Load earlier action', prefetch: 'Background prefetch',
    prefetchHint: 'After the initial history appears, load older turns up to the target for opening a session.',
    invalidCount: 'Enter a positive integer.', invalidMiB: 'Enter a MiB value greater than zero.',
    invalidOpen: 'Enter an integer of at least 3.',
    loading: 'Loading…', retry: 'Retry', loadFailed: 'Could not load session history settings.',
    save: 'Save', saving: 'Saving…', saveFailed: 'Could not save session history settings. Your edits are still here.',
  },
}

const invalidLabel = { firstItems: 'invalidCount', firstMiB: 'invalidMiB', openTurns: 'invalidOpen', manualTurns: 'invalidCount' }
const sectionStyle = { paddingBlock: 16, borderBottom: '1px solid var(--dsw-alias-border-l2)' }
const hintStyle = { margin: '4px 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }

function HistoryPreferences({ t, ownerSignal }) {
  const id = useId()
  const [accepted, setAccepted] = useState(null)
  const [edits, setEdits] = useState({})
  const [attempt, setAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, ownerSignal])
    void readPage(endpoint, {}, signal).then(settings => {
      if (!signal.aborted) setAccepted(settings)
    }).catch(() => {
      if (!signal.aborted) setLoadFailed(true)
    })
    return () => lifetime.abort()
  }, [attempt, ownerSignal])

  function edit(key, value) {
    setEdits(previous => ({ ...previous, [key]: value }))
    setFailed(false)
  }

  const text = Object.fromEntries(numericFields.map(key => [key, edits[key] ?? String(accepted?.[key] ?? '')]))
  const next = Object.fromEntries(numericFields.map(key => [key, Number(text[key])]))
  next.prefetch = edits.prefetch ?? accepted?.prefetch
  const invalid = key => !isHistoryPreferenceValue(key, next[key])
  const state = {
    available: Boolean(accepted), writable: Boolean(accepted), failed, saving,
    invalid: numericFields.some(invalid),
    dirty: Boolean(accepted && Object.keys(next).some(key => next[key] !== accepted[key])),
  }

  async function save() {
    if (!state.dirty || state.invalid || saving) return
    setSaving(true)
    setFailed(false)
    try {
      setAccepted(await writeCodexCapability(endpoint, next, ownerSignal))
      setEdits({})
    } catch {
      if (!ownerSignal.aborted) setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return <section style={sectionStyle} aria-labelledby={`${id}-title`}>
    <div id={`${id}-title`}>{t('title')}</div>
    {!accepted ? <>
      <p role={loadFailed ? 'alert' : 'status'} style={hintStyle}>{t(loadFailed ? 'loadFailed' : 'loading')}</p>
      {loadFailed && <Button size="sm" variant="outline" onClick={() => {
        setLoadFailed(false)
        setAttempt(value => value + 1)
      }}>{t('retry')}</Button>}
    </> : <>
      <p style={hintStyle}>{t('description')}</p>
      <SettingsForm labels={{ save: t('save'), saving: t('saving'), saveFailed: t('saveFailed') }}
        state={state} onSave={save} onDiscard={() => setEdits({})}>
        {numericFields.map(key => <SettingsValueField key={key} id={`${id}-${key}`} label={t(key)}
          numeric={key !== 'firstMiB'} text={text[key]} disabled={saving}
          invalid={invalid(key)} invalidLabel={t(invalidLabel[key])} onEdit={value => edit(key, value)} />)}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>{t('prefetch')}</div>
            <p id={`${id}-prefetch`} style={hintStyle}>{t('prefetchHint')}</p>
          </div>
          <Switch checked={next.prefetch} label={t('prefetch')} describedBy={`${id}-prefetch`}
            disabled={saving} onChange={value => edit('prefetch', value)} />
        </div>
      </SettingsForm>
    </>}
  </section>
}

/** 将历史加载表单放进 DSH 通用设置，保存与读取走同一个 Profile 的 Host。 */
export function installHistoryPreferences(ctx, ownerSignal) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'codex-history-preferences', order: -18, locale, inject: () => ({ ownerSignal }),
  }, HistoryPreferences))
}
