import css from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.module.css'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import { historyPreferenceLimits, isHistoryPreferenceValue } from '../../shared/history-preferences.js'
import { readPage, writeCodexCapability } from '../api.js'
import { codexHistorySettings } from './codex-settings.jsx'

const locale = 'codex.history-preferences'
const endpoint = 'history-preferences'
const numericFields = {
  firstItems: 'invalidCount', firstMiB: 'invalidMiB', openTurns: 'invalidOpen', manualTurns: 'invalidCount',
}
const labels = {
  zh: {
    firstItems: '历史首屏条目数预算', firstMiB: '历史首屏体积预算（MiB）',
    openTurns: '打开时加载轮数', manualTurns: '每次加载更早的轮数', prefetch: '后台预读',
    firstItemsHint: '用于加速打开会话的时间。调大后，打开会话时可以先看到更多对话记录，但可能等待较久。调小能更快打开较大的会话。',
    firstMiBHint: '如果长回复或大段输出打开时经常只看到摘要，可以调大，以便直接看到全文。调小可缩短打开时的等待。',
    openTurnsHint: '决定打开会话后准备多少轮近期对话。调大会加载更多的历史轮次，但可能延长载入时间。',
    manualTurnsHint: '决定「加载更早」会准备多少轮对话。调小则每次加载的量更少。',
    prefetchHint: '开启后会自动准备更早的对话轮次。关闭则不再自动加载。',
    invalidCount: '请输入正整数。', invalidMiB: '请输入大于零的 MiB 数值。',
    invalidOpen: '请输入至少为 3 的整数。',
    loading: '正在读取设置…', retry: '重试', loadFailed: '无法读取会话历史设置。',
    writeFailed: '无法应用此项设置。请重试。',
  },
  en: {
    firstItems: 'Initial history item budget', firstMiB: 'Initial history size budget (MiB)',
    openTurns: 'Turns to load on open', manualTurns: 'Turns per Load earlier action', prefetch: 'Background prefetch',
    firstItemsHint: 'This budget helps sessions open faster. Raise it to see more conversation history right away, though opening may take longer. Lower it to open large sessions faster.',
    firstMiBHint: 'If long replies or large blocks of output often appear only as summaries when you open a session, raise this to see the full content right away. Lower it to reduce the wait.',
    openTurnsHint: 'Sets how many recent turns to prepare when you open a session. A higher value loads more turns but may take longer.',
    manualTurnsHint: 'Sets how many turns Load earlier prepares. Lower it to load fewer turns at a time.',
    prefetchHint: 'When enabled, older turns load automatically. Turning this off stops automatic loading of older turns.',
    invalidCount: 'Enter a positive integer.', invalidMiB: 'Enter a MiB value greater than zero.',
    invalidOpen: 'Enter an integer of at least 3.',
    loading: 'Loading settings…', retry: 'Retry', loadFailed: 'Could not load session history settings.',
    writeFailed: 'Could not apply this setting. Try again.',
  },
}

function HistoryNumberField({ field, invalidLabel, value, status, apply, t }) {
  const id = useId()
  const [draft, setDraft] = useState(null)
  const next = Number(draft)
  const invalid = draft !== null && !isHistoryPreferenceValue(field, next)
  const description = t(invalid ? invalidLabel : status === 'failed' ? 'writeFailed' : `${field}Hint`)

  async function commit() {
    if (draft === null || invalid || status === 'pending') return
    if (next === value || await apply(field, next)) setDraft(null)
  }

  return <div className={css.row}>
    <div className={css.rowText}>
      <label className={css.title} htmlFor={id}>{t(field)}</label>
      <div className={css.desc} id={`${id}-description`}
        role={status === 'failed' ? 'alert' : undefined}>{description}</div>
    </div>
    <Input id={id} size={8} inputMode={historyPreferenceLimits[field].step === 'any' ? 'decimal' : 'numeric'}
      value={draft ?? String(value ?? '')} disabled={value === undefined || status === 'pending'} aria-invalid={invalid || undefined}
      aria-describedby={`${id}-description`}
      onChange={event => setDraft(event.target.value)} onBlur={() => void commit()}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }} />
  </div>
}

function HistoryPreferences({ t, ownerSignal }) {
  const id = useId()
  const [settings, setSettings] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [status, setStatus] = useState({})

  useEffect(() => {
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, ownerSignal])
    void readPage(endpoint, {}, signal).then(result => {
      if (!signal.aborted) setSettings(result)
    }).catch(() => {
      if (!signal.aborted) setLoadFailed(true)
    })
    return () => lifetime.abort()
  }, [attempt, ownerSignal])

  async function apply(field, value) {
    setStatus(previous => ({ ...previous, [field]: 'pending' }))
    try {
      const result = await writeCodexCapability(endpoint, { [field]: value }, ownerSignal)
      if (ownerSignal.aborted) return false
      // 不同字段的写入可以并发，应答只更新本次提交的字段。
      setSettings(previous => ({ ...previous, [field]: result[field] }))
      setStatus(previous => ({ ...previous, [field]: undefined }))
      return true
    } catch {
      if (!ownerSignal.aborted) setStatus(previous => ({ ...previous, [field]: 'failed' }))
      return false
    }
  }

  return <>
    {Object.entries(numericFields).map(([field, invalidLabel]) => <HistoryNumberField key={field}
      {...{ field, invalidLabel, apply, t }} value={settings?.[field]} status={status[field]} />)}
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('prefetch')}</div>
        <div id={id} className={css.desc} role={status.prefetch === 'failed' ? 'alert' : undefined}>
          {t(status.prefetch === 'failed' ? 'writeFailed' : 'prefetchHint')}
        </div>
        {loadFailed && <div className={css.desc} role="alert">{t('loadFailed')}</div>}
      </div>
      {settings ? <Switch checked={settings.prefetch} label={t('prefetch')} describedBy={id} disabled={status.prefetch === 'pending'}
        onChange={value => void apply('prefetch', value)} />
        : loadFailed ? <Button size="sm" variant="outline" onClick={() => {
          setLoadFailed(false)
          setAttempt(value => value + 1)
        }}>{t('retry')}</Button>
          : <span className={css.desc} role="status">{t('loading')}</span>}
    </div>
  </>
}

/** 将逐项应用的历史偏好放到 Codex 设置页，沿用当前 Profile 的 Host 存储。 */
export function installHistoryPreferences(ctx, ownerSignal) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject(codexHistorySettings, () => ctx.slots.register({
    name: codexHistorySettings, locale, inject: () => ({ ownerSignal }),
  }, HistoryPreferences))
}
