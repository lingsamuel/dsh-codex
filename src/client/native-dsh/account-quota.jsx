import { Button, MenuSurface, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useSyncExternalStore } from 'react'
import css from './account-quota.module.css'

const slot = 'conversation.input.right'
const locale = 'codex.accountQuota'
const copy = {
  zh: { title: 'Codex 账户额度', summary: 'Codex 账户额度，剩余 {percent}%',
    remaining: '剩余 {percent}%', resetsAt: '{time} 重置', resetsIn: '{duration}后重置',
    shortDays: '{count} 天', shortHours: '{count} 小时', shortMinutes: '{count} 分钟',
    minutes: '{count} 分钟额度', hours: '{count} 小时额度',
    days: '{count} 天额度', weekly: '周额度', primary: '主要额度', secondary: '次要额度', dateLocale: 'zh-CN' },
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
  const low = remaining < 10
  const size = low ? 26 : 20
  // 低余量时展开 0–10% 的弧长，中心数字仍表示真实的账户余量。
  const arc = low ? remaining * 10 : remaining
  return <svg viewBox="0 0 20 20" width={size} height={size} data-low={low || undefined} aria-hidden="true">
    <circle className={css.track} cx="10" cy="10" r="8" />
    {low ? <text className={css.reading} x="10" y="10" textAnchor="middle" dominantBaseline="central">{remaining}</text>
      : <circle className={css.center} cx="10" cy="10" r="2.5" />}
    {remaining > 0 && <circle className={css.arc} cx="10" cy="10" r="8" pathLength="100"
      strokeDasharray={`${arc} 100`} transform="rotate(-90 10 10)" />}
  </svg>
}

function resetLabel(resetsAt, t) {
  const minutes = Math.ceil((resetsAt * 1000 - Date.now()) / 60_000)
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

function QuotaWindow({ window, t }) {
  const values = <><span>{windowLabel(window, t)}</span>
    <span className={css.remaining}>{t('remaining', { percent: window.remaining })}</span></>
  return <li>
    {window.resetsAt == null ? <div className={css.row}>{values}</div>
      // 详情本身在浏览器顶层，提示也留在详情内，避免被浮层盖住。
      : <Tooltip label={() => resetLabel(window.resetsAt, t)} side="right" delayMs={160} openOnClick>
        <Button className={css.row} size="sm" variant="ghost">{values}</Button>
      </Tooltip>}
  </li>
}

function AccountQuota({ store, active, t }) {
  const windows = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const id = useId()
  if (!active || !windows) return null
  const anchorName = `--codex-account-quota-${id.replaceAll(':', '')}`
  const remaining = Math.min(...windows.map(window => window.remaining))
  const summary = t('summary', { percent: remaining })
  return <>
    <Tooltip label={summary} side="top" delayMs={300} portal>
      <Button className={css.trigger} size="sm" variant="ghost" popovertarget={id} aria-label={summary} style={{ anchorName }}>
        <QuotaRing remaining={remaining} />
      </Button>
    </Tooltip>
    <section id={id} popover="auto" aria-label={t('title')} className={css.panel} style={{ positionAnchor: anchorName }}>
      <MenuSurface compact className={css.content}>
        <p className={css.caption}>{t('title')}</p>
        <ul className={css.windows}>
          {windows.map(window => <QuotaWindow key={window.key} window={window} t={t} />)}
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
