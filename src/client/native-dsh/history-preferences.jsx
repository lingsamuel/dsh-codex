import css from '@deepseek-ai/dsh-client-ui-chat/src/client/settings/PreferenceRow.module.css'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import { historyPreferenceLimits, isHistoryPreferenceValue } from '../../shared/history-preferences.js'
import { readPage, writeCodexCapability } from '../api.js'
import { codexSettingsItem } from './codex-settings.jsx'

const locale = 'codex.history-preferences'
const endpoint = 'history-preferences'
const numericFields = {
  firstItems: 'invalidCount', firstMiB: 'invalidMiB', openTurns: 'invalidOpen', manualTurns: 'invalidCount',
}
const labels = {
  zh: {
    firstItems: '历史首屏条目数预算', firstMiB: '历史首屏体积预算（MiB）',
    openTurns: '打开时加载轮数', manualTurns: '每次加载更早的轮数', prefetch: '后台预读',
    firstItemsHint: '首屏预算按消息、工具调用和工具结果等条目计数。预算不足时，最近三轮仍可先显示摘要。',
    firstMiBHint: '限制首屏历史数据的大小。长回复或大量工具输出会用掉更多预算，减少首屏能完整显示的轮次。',
    openTurnsHint: '打开会话时要加载的最近轮数，包含首屏已显示和后台预读补齐的轮次。',
    manualTurnsHint: '每次点击「加载更早」最多往前读这么多轮。每读完一轮就显示，可以边加载边看。',
    prefetchHint: '首屏显示后自动补齐到目标轮数。关闭后，点击「加载更早」继续读取。',
    invalidCount: '请输入正整数。', invalidMiB: '请输入大于零的 MiB 数值。',
    invalidOpen: '请输入至少为 3 的整数。',
    loading: '正在读取会话历史设置…', retry: '重试', loadFailed: '无法读取会话历史设置。',
    writeFailed: '无法应用此项设置。请重试。',
  },
  en: {
    firstItems: 'Initial history item budget', firstMiB: 'Initial history size budget (MiB)',
    openTurns: 'Turns to load on open', manualTurns: 'Turns per Load earlier action', prefetch: 'Background prefetch',
    firstItemsHint: 'Messages, tool calls, and tool results all count toward the initial budget. The latest three turns can appear as summaries if they exceed it.',
    firstMiBHint: 'Limits the size of the initial history. Long replies and large tool outputs use more of the budget, so fewer turns may appear in full.',
    openTurnsHint: 'Target number of recent turns to load when opening a session, including turns shown initially and those added by background prefetch.',
    manualTurnsHint: 'Each click on Load earlier fetches up to this many older turns. Each turn appears as soon as it is ready.',
    prefetchHint: 'Fill in older turns up to the target after the initial history appears. When off, click Load earlier to continue.',
    invalidCount: 'Enter a positive integer.', invalidMiB: 'Enter a MiB value greater than zero.',
    invalidOpen: 'Enter an integer of at least 3.',
    loading: 'Loading session history settings…', retry: 'Retry', loadFailed: 'Could not load session history settings.',
    writeFailed: 'Could not apply this setting. Try again.',
  },
}

function HistoryNumberField({ field, invalidLabel, value, status, apply, t }) {
  const id = useId()
  const [draft, setDraft] = useState(null)
  const next = draft === null ? value : Number(draft)
  const invalid = !isHistoryPreferenceValue(field, next)
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
      value={draft ?? String(value)} disabled={status === 'pending'} aria-invalid={invalid || undefined}
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

  if (!settings) return <div className={css.row}>
    <div className={css.rowText} role={loadFailed ? 'alert' : 'status'}>{t(loadFailed ? 'loadFailed' : 'loading')}</div>
    {loadFailed && <Button size="sm" variant="outline" onClick={() => {
      setLoadFailed(false)
      setAttempt(value => value + 1)
    }}>{t('retry')}</Button>}
  </div>

  return <>
    {Object.entries(numericFields).map(([field, invalidLabel]) => <HistoryNumberField key={field}
      {...{ field, invalidLabel, apply, t }} value={settings[field]} status={status[field]} />)}
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('prefetch')}</div>
        <div id={id} className={css.desc} role={status.prefetch === 'failed' ? 'alert' : undefined}>
          {t(status.prefetch === 'failed' ? 'writeFailed' : 'prefetchHint')}
        </div>
      </div>
      <Switch checked={settings.prefetch} label={t('prefetch')} describedBy={id} disabled={status.prefetch === 'pending'}
        onChange={value => void apply('prefetch', value)} />
    </div>
  </>
}

/** 将逐项应用的历史偏好放到 Codex 设置页，沿用当前 Profile 的 Host 存储。 */
export function installHistoryPreferences(ctx, ownerSignal) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject(codexSettingsItem, () => ctx.slots.register({
    name: codexSettingsItem, id: 'codex-history-preferences', order: -18, locale, inject: () => ({ ownerSignal }),
  }, HistoryPreferences))
}
