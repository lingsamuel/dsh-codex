import { useLayoutEffect, useSyncExternalStore } from 'react'

const bar = 'conversation.composer.bar'
const locale = 'codex.composer'
const copy = {
  zh: { readonly: '请在 Codex CLI 发送消息', loading: '正在载入会话…', select: '选择一个 Codex 会话浏览历史', commands: '指令' },
  en: { readonly: 'Send messages in Codex CLI', loading: 'Loading sessions…', select: 'Select a Codex session to browse its history', commands: 'Commands' },
}
const commandKeys = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'escape', Tab: 'tab' }

function CatalogStatus({ catalog, t }) {
  const { busy, error, selected } = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  if (error) return <p role="alert">{error}</p>
  if (selected) return null
  return <p role="status">{t(busy ? 'loading' : 'select')}</p>
}

function ReadonlyComposer({ Native, commandsLabel, ...props }) {
  const { blocked, disabled, keyboard, t, toggleCommandMenu } = props
  useLayoutEffect(() => {
    if (!blocked || disabled || !toggleCommandMenu) return
    const card = keyboard.editor.getRootElement()?.closest('[data-composer-card]')
    const button = Array.from(card?.querySelectorAll('button[aria-haspopup="listbox"]') ?? [])
      .find(button => button.getAttribute('aria-label') === commandsLabel)
    if (!button) return
    // RC2 的 + 与编辑器共用锁定条件。保留 DSH 的输入锁，仅让原生 + 驱动同一命令控制器。
    button.disabled = false
    const toggle = event => {
      event.stopPropagation()
      button.focus({ preventScroll: true })
      toggleCommandMenu(keyboard.caretSpan())
    }
    const navigate = event => {
      if (button.getAttribute('aria-expanded') !== 'true') return
      const key = event.shiftKey && event.key === 'Tab' ? 'tabBack' : commandKeys[event.key]
      if (!key || keyboard.arbitrate(key, event.isComposing) === 'pass') return
      event.preventDefault()
      event.stopPropagation()
    }
    button.addEventListener('click', toggle)
    button.addEventListener('keydown', navigate)
    return () => {
      button.removeEventListener('click', toggle)
      button.removeEventListener('keydown', navigate)
      button.disabled = true
    }
  }, [blocked, commandsLabel, disabled, keyboard, toggleCommandMenu])
  return <Native {...props} t={(key, ...args) => key === 'input.commands' && toggleCommandMenu ? commandsLabel : t(key, ...args)} />
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
      const Component = entry?.component
      if (!inject || !Component) return
      // RC2 的 Stop 独立于输入锁。保留真实 running 供聊天进度使用，仅撤下输入栏的停止回调。
      const injectReadonly = (sessionId, ...args) => ({
        ...inject(sessionId, ...args),
        addFiles: undefined,
        stop: undefined,
        ...(sessionId === undefined ? { accessory: <CatalogStatus catalog={catalog} t={t} /> } : {}),
      })
      function Composer(props) {
        return <ReadonlyComposer {...props} Native={Component} commandsLabel={t('commands')} />
      }
      entry.inject = injectReadonly
      entry.component = Composer
      restore = () => {
        if (entry.inject === injectReadonly) entry.inject = inject
        if (entry.component === Composer) entry.component = Component
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
