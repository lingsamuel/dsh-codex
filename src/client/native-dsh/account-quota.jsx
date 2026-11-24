import { Button, MenuSurface, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import css from './account-quota.module.css'

const slot = 'conversation.input.right'
const locale = 'codex.accountQuota'
const lowQuota = 10
const copy = {
  zh: { title: 'Codex 账户额度', summary: 'Codex 账户额度，剩余 {percent}%',
    remaining: '剩余 {percent}%', resetsAt: '{time} 重置', resetsIn: '{duration}后重置',
    shortDays: '{count} 天', shortHours: '{count} 小时', shortMinutes: '{count} 分钟',
    minutes: '{count} 分钟限额', hours: '{count} 小时限额',
    days: '{count} 天限额', weekly: '每周限额', primary: '主要限额', secondary: '次要限额', dateLocale: 'zh-CN' },
  en: { title: 'Codex account limits', summary: 'Codex usage, {percent}% left',
    remaining: '{percent}% left', resetsAt: 'Resets {time}', resetsIn: 'Resets in {duration}',
    shortDays: '{count}d', shortHours: '{count}h', shortMinutes: '{count}m',
    minutes: '{count}-minute limit', hours: '{count}-hour limit',
    days: '{count}-day limit', weekly: 'Weekly limit', primary: 'Primary limit', secondary: 'Secondary limit', dateLocale: 'en' },
}

function windowLabel({ key, minutes }, t) {
  if (!minutes) return t(key)
  if (minutes === 10080) return t('weekly')
  if (minutes % 1440 === 0) return t('days', { count: minutes / 1440 })
  if (minutes % 60 === 0) return t('hours', { count: minutes / 60 })
  return t('minutes', { count: minutes })
}

function QuotaRing({ remaining }) {
  const low = remaining < lowQuota
  // 低余量时展开 0–10% 的弧长，中心数字仍表示真实的账户余量。
  const arc = low ? remaining * (100 / lowQuota) : remaining
  return <>
    <svg viewBox="0 0 20 20" width="20" height="20" data-low={low || undefined} aria-hidden="true">
      <circle className={css.track} cx="10" cy="10" r="8" />
      {!low && <circle className={css.center} cx="10" cy="10" r="2.5" />}
      {remaining > 0 && <circle className={css.arc} cx="10" cy="10" r="8" pathLength="100"
        strokeDasharray={`${arc} 100`} transform="rotate(-90 10 10)" />}
    </svg>
    {low && <span className={css.reading} aria-hidden="true">{remaining}</span>}
  </>
}

function resetLabel(resetsAt, now, t) {
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60_000)
  if (minutes <= 0) {
    const format = new Intl.DateTimeFormat(t('dateLocale'), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    return t('resetsAt', { time: format.format(resetsAt * 1000) })
  }
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const parts = days ? [['shortDays', days], ['shortHours', hours % 24]]
    : [['shortHours', hours], ['shortMinutes', minutes % 60]]
  return t('resetsIn', { duration: parts.filter(([, count]) => count).map(([key, count]) => t(key, { count })).join(' ') })
}

function QuotaWindow({ window, now, t }) {
  return <li className={css.window}>
    <h2 className={css.title}>{windowLabel(window, t)}</h2>
    <div className={css.meta}>
      {window.resetsAt != null && <span>{resetLabel(window.resetsAt, now, t)}</span>}
      <span className={css.remaining}>{t('remaining', { percent: window.remaining })}</span>
    </div>
    <progress className={css.meter} data-low={window.remaining < lowQuota || undefined}
      max={100} value={window.remaining} aria-hidden="true" />
  </li>
}

function AccountQuota({ store, active, t }) {
  const windows = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const id = useId()
  const panel = useRef(null)
  const [now, setNow] = useState(Date.now)
  const available = active && Boolean(windows)
  useEffect(() => {
    const element = panel.current
    if (!element) return
    let timer
    const updateTime = () => setNow(Date.now())
    // 原生浮层负责开关，倒计时只在展开时更新。
    const onToggle = event => {
      clearInterval(timer)
      if (event.newState !== 'open') return
      updateTime()
      timer = setInterval(updateTime, 30_000)
    }
    element.addEventListener('toggle', onToggle)
    return () => {
      element.removeEventListener('toggle', onToggle)
      clearInterval(timer)
    }
  }, [available])
  if (!available) return null
  const anchorName = `--codex-account-quota-${id.replaceAll(':', '')}`
  const remaining = Math.min(...windows.map(window => window.remaining))
  const summary = t('summary', { percent: remaining })
  return <>
    <Tooltip label={summary} side="top" delayMs={300} portal>
      <Button className={css.trigger} size="sm" variant="ghost" popovertarget={id} aria-label={summary} style={{ anchorName }}>
        <QuotaRing remaining={remaining} />
      </Button>
    </Tooltip>
    <section ref={panel} id={id} popover="auto" aria-label={t('title')} className={css.panel} style={{ positionAnchor: anchorName }}>
      <MenuSurface className={css.content}>
        <ul className={css.windows}>
          {windows.map(window => <QuotaWindow key={window.key} window={window} now={now} t={t} />)}
        </ul>
      </MenuSurface>
    </section>
  </>
}

/** 额度是账户数据。只有 Codex 会话绑定使用该插槽，原生 DSH 会话没有额度入口。 */
export function installAccountQuota(ctx, store) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.inject(['sessions'], scope => scope.slots.inject(slot, () => scope.slots.register({
    name: slot, id: 'codex-account-quota', order: 100, locale,
    inject: sessionId => ({ store, active: Boolean(scope.sessions.binding(sessionId)) }),
  }, AccountQuota)))
}
