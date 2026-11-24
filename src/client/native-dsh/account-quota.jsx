import { Button, MenuSurface, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useSyncExternalStore } from 'react'
import css from './account-quota.module.css'

const slot = 'conversation.input.right'
const locale = 'codex.accountQuota'
const copy = {
  zh: { label: '额度', title: 'Codex 账户额度', summary: 'Codex 账户额度，剩余 {percent}%',
    remaining: '剩余 {percent}%', resets: '{time} 重置', minutes: '{count} 分钟额度', hours: '{count} 小时额度',
    days: '{count} 天额度', weekly: '周额度', primary: '主要额度', secondary: '次要额度', dateLocale: 'zh-CN' },
  en: { label: 'Usage', title: 'Codex account limits', summary: 'Codex usage, {percent}% left',
    remaining: '{percent}% left', resets: 'Resets {time}', minutes: '{count}-minute limit', hours: '{count}-hour limit',
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
  return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <circle className={css.track} cx="10" cy="10" r="7.5" />
    {remaining > 0 && <circle className={css.arc} cx="10" cy="10" r="7.5" pathLength="100"
      strokeDasharray={`${remaining} 100`} transform="rotate(-90 10 10)" />}
  </svg>
}

function AccountQuota({ store, active, t }) {
  const windows = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const id = useId()
  if (!active || !windows) return null
  const anchorName = `--codex-account-quota-${id.replaceAll(':', '')}`
  const remaining = Math.min(...windows.map(window => window.remaining))
  const summary = t('summary', { percent: remaining })
  const resetFormat = new Intl.DateTimeFormat(t('dateLocale'), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return <>
    <Tooltip label={summary} side="top" delayMs={300} portal>
      <Button size="sm" variant="ghost" popovertarget={id} aria-label={summary} style={{ anchorName }}
        icon={<QuotaRing remaining={remaining} />}>{t('label')}</Button>
    </Tooltip>
    <section id={id} popover="auto" aria-label={t('title')} className={css.panel} style={{ positionAnchor: anchorName }}>
      <MenuSurface className={css.content}>
        <h2 className={css.title}>{t('title')}</h2>
        <dl className={css.windows}>
          {windows.map(window => <div className={css.window} key={window.key}>
            <dt>{windowLabel(window, t)}</dt>
            <dd>{t('remaining', { percent: window.remaining })}</dd>
            {window.resetsAt != null && <dd className={css.reset}>
              {t('resets', { time: resetFormat.format(window.resetsAt * 1000) })}
            </dd>}
          </div>)}
        </dl>
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
