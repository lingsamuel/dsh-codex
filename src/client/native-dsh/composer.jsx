import { useSyncExternalStore } from 'react'

const bar = 'conversation.composer.bar'
const locale = 'codex.composer'
const copy = {
  zh: { readonly: '请在 Codex CLI 发送消息', loading: '正在载入会话…', select: '选择一个 Codex 会话浏览历史' },
  en: { readonly: 'Send messages in Codex CLI', loading: 'Loading sessions…', select: 'Select a Codex session to browse its history' },
}

function CatalogStatus({ catalog, t }) {
  const { busy, error, selected } = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  if (error) return <p role="alert">{error}</p>
  if (selected) return null
  return <p role="status">{t(busy ? 'loading' : 'select')}</p>
}

/** 复用原生编辑器、底栏和上下文占用，由 DSH 的会话级阻止条件锁定输入。 */
export function installComposer(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  const t = ctx.locale.bind(locale)

  ctx.inject(['conversation', 'uiSession'], scope => {
    const { blocks } = scope.conversation
    const installed = new WeakSet()
    scope.uiSession.provide({
      resolve(binding) {
        if (!installed.has(binding)) {
          installed.add(binding)
          binding.ctx.effect(() => {
            const sync = () => blocks.set(binding.sessionId, { reason: t('readonly') })
            sync()
            const unsubscribe = ctx.locale.subscribe(sync)
            return () => {
              unsubscribe()
              blocks.forget(binding.sessionId)
            }
          })
        }
        return {}
      },
    })
  })

  ctx.effect(() => {
    let native
    let restore
    function sync() {
      const entry = ctx.slots.entries(bar).find(entry => entry.children?.['conversation.input.attachments'])
      if (entry === native) return
      restore?.()
      native = entry
      restore = undefined
      const inject = entry?.inject
      if (!inject) return
      // RC2 的 Stop 独立于输入锁。保留真实 running 供聊天进度使用，仅撤下输入栏的停止回调。
      const injectReadonly = (sessionId, ...args) => ({
        ...inject(sessionId, ...args),
        stop: undefined,
        ...(sessionId === undefined ? { accessory: <CatalogStatus catalog={catalog} t={t} /> } : {}),
      })
      entry.inject = injectReadonly
      restore = () => {
        if (entry.inject === injectReadonly) entry.inject = inject
      }
    }
    const unsubscribe = ctx.on('slots/changed', name => { if (name === bar) sync() })
    sync()
    return () => {
      unsubscribe()
      restore?.()
    }
  })
}
