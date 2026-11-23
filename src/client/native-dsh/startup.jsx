import { useSyncExternalStore } from 'react'
import { adaptSlot } from './slot-adapter.js'

const locale = 'codex.startup'
export const sessionLoadingCopy = {
  zh: { loading: '正在载入会话…' },
  en: { loading: 'Loading session…' },
}

export function readStartupBoot() {
  return document.querySelector('#root > [data-dsh-boot]')
}

/** 插件启动结束后，沿用 DSH 样式显示首次会话的载入状态。 */
export function installStartupPage(ctx, startupReady) {
  const boot = readStartupBoot()
  const card = boot?.firstElementChild?.cloneNode(true)
  const spinner = card?.querySelector('[data-dsh-boot-spinner]')
  const hint = spinner?.nextElementSibling
  if (!hint) return

  // 会话读取没有进度百分比，转圈沿用 DSH 的默认弧长。
  spinner.style.removeProperty('--dsh-boot-arc')
  ctx.effect(() => ctx.locale.register(locale, sessionLoadingCopy))
  const t = ctx.locale.bind(locale)
  const subscribe = listener => ctx.locale.subscribe(listener)

  function SessionLoadingPage() {
    const label = useSyncExternalStore(subscribe, () => t('loading'))
    return <div className={boot.className} data-codex-session-loading role="status" ref={element => {
      if (!element) return
      hint.textContent = label
      if (card.parentElement !== element) element.append(card)
    }} />
  }

  ctx.inject(['uiWorkspace', 'layout'], scope => adaptSlot(scope, 'root', entry => Boolean(entry.children?.main), (inject, Layout) => ({
    inject,
    component: function StartupLayout(props) {
      const ready = useSyncExternalStore(startupReady.subscribe, startupReady.getSnapshot)
      return ready ? <Layout {...props} /> : <SessionLoadingPage />
    },
  })))
}
