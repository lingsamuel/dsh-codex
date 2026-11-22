import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'

const bar = 'conversation.composer.bar'
const dock = 'conversation.composer.dock'
const locale = 'codex.composer'
const copy = {
  zh: { readonly: '此会话无法直接发送消息', archived: '请先取消归档',
    loading: '正在载入会话…', unavailable: '会话历史未就绪',
    select: '选择一个 Codex 会话浏览历史', commands: '指令', continueQueue: '继续队列' },
  en: { readonly: 'Direct messages are unavailable for this session', archived: 'Unarchive the session to send messages',
    loading: 'Loading sessions…', unavailable: 'Conversation history is unavailable',
    select: 'Select a Codex session to browse its history', commands: 'Commands', continueQueue: 'Continue queue' },
}
const commandKeys = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'escape', Tab: 'tab' }

function CatalogStatus({ catalog, t }) {
  const { busy, error, selected } = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  if (error) return <p role="alert">{error}</p>
  if (selected) return null
  return <p role="status">{t(busy ? 'loading' : 'select')}</p>
}

function ComposerBar({ Native, commandsLabel, ...props }) {
  const { blocked, disabled, keyboard, t, toggleCommandMenu } = props
  const knownTurn = props.useSession(state => state.running && Boolean(state.live.activeTurnId))
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
    }
  }, [blocked, commandsLabel, disabled, keyboard, toggleCommandMenu])
  return <Native {...props} stop={!blocked && knownTurn ? props.stop : undefined}
    t={(key, ...args) => key === 'input.commands' && toggleCommandMenu ? commandsLabel : t(key, ...args)} />
}

function ContinueQueue({ useSession, useProjection, startQueue, t }) {
  const ready = useSession(state => state.openState === 'open' && !state.archived && !state.subagent
    && state.canAcceptDirectInput !== false && ['idle', 'notLoaded'].includes(state.live.status?.type))
  const queued = useProjection('inbox', inbox => Boolean(inbox?.['next-turn']?.length))
  const [starting, setStarting] = useState(false)
  if (!ready || !queued) return null
  return <Button size="sm" variant="outline" disabled={starting} onClick={async () => {
    setStarting(true)
    try {
      await startQueue()
    } finally {
      setStarting(false)
    }
  }}>{t('continueQueue')}</Button>
}

/** 原生编辑器负责发送手势和草稿。停止后，可在原生队列下方手动继续。 */
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
            const { sessionId, session } = binding
            const sync = () => {
              const { archived, subagent, canAcceptDirectInput, openState } = session.getSnapshot()
              const reason = archived ? 'archived' : subagent || canAcceptDirectInput === false ? 'readonly'
                : openState === 'loading' ? 'loading' : openState !== 'open' ? 'unavailable' : undefined
              blocks.set(sessionId, reason ? { reason: t(reason) } : undefined)
            }
            sync()
            const unsubscribeLocale = ctx.locale.subscribe(sync)
            const unsubscribeSession = session.subscribe(sync)
            return () => {
              unsubscribeLocale()
              unsubscribeSession()
              blocks.forget(sessionId)
            }
          })
        }
        return {}
      },
    })
  })

  ctx.inject(['sessions'], scope => {
    scope.slots.inject(dock, () => scope.slots.register({
      name: dock, id: 'codex-continue-queue', order: 50, locale,
      inject: sessionId => ({ startQueue: scope.sessions.binding(sessionId)?.session.startQueue }),
    }, ContinueQueue))
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
      const injectComposer = (sessionId, ...args) => ({
        ...inject(sessionId, ...args),
        // 此阶段只开放文本输入，Codex 的通用附件流尚未接入。
        addFiles: undefined,
        ...(sessionId === undefined ? { accessory: <CatalogStatus catalog={catalog} t={t} /> } : {}),
      })
      function Composer(props) {
        return <ComposerBar {...props} Native={Component} commandsLabel={t('commands')} />
      }
      entry.inject = injectComposer
      entry.component = Composer
      restore = () => {
        if (entry.inject === injectComposer) entry.inject = inject
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
