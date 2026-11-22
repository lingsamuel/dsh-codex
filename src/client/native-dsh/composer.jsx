import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { installQueueImages } from './queue-images.jsx'
import { allowsDirectInput } from './subagents.js'
import { isLocalSessionId } from '../../shared/local-session.js'

const composer = 'conversation.composer'
const bar = 'conversation.composer.bar'
const dock = 'conversation.composer.dock'
const locale = 'codex.composer'
const copy = {
  zh: { readonly: '此会话无法直接发送消息', unarchiveAndSend: '取消归档并发送', unarchiveAndContinue: '取消归档并继续队列',
    subagentReadonly: '此子智能体为只读', subagentReadonlyBody: 'Codex 不允许直接向此子智能体发送消息。',
    subagentCapabilityUnknown: 'Codex 尚未提供此子会话的直接输入能力。',
    goalPlaceholder: '输入要交给 Codex 的目标', goalSend: '创建目标', goalUnarchiveAndSend: '取消归档并创建目标',
    changingPlan: '正在等待 Codex 确认计划模式…',
    loading: '正在载入会话…', unavailable: '会话历史未就绪',
    commands: '指令', skillHint: '$ 选择技能', continueQueue: '继续队列',
    filesOnly: '请选择文件。工作区目录可以用 @ 引用。', fileInputUnavailable: '当前无法添加文件。' },
  en: { readonly: 'Direct messages are unavailable for this session', unarchiveAndSend: 'Unarchive and send', unarchiveAndContinue: 'Unarchive and continue queue',
    subagentReadonly: 'This subagent is read-only', subagentReadonlyBody: 'Codex does not allow direct messages to this subagent.',
    subagentCapabilityUnknown: 'Codex has not reported whether this child session accepts direct input.',
    goalPlaceholder: 'Describe the goal for Codex', goalSend: 'Create goal', goalUnarchiveAndSend: 'Unarchive and create goal',
    changingPlan: 'Waiting for Codex to confirm Plan mode…',
    loading: 'Loading sessions…', unavailable: 'Conversation history is unavailable',
    commands: 'Commands', skillHint: '$ select a skill', continueQueue: 'Continue queue',
    filesOnly: 'Choose files. Use @ to reference a workspace folder.', fileInputUnavailable: 'Files cannot be added right now.' },
}
const commandKeys = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'escape', Tab: 'tab' }
const noGoalDraft = createSnapshotStore(undefined)

function ComposerBar({ Native, commandsLabel, unarchiveLabel, skillHint, goalDraft = noGoalDraft, composerT, ...props }) {
  const { blocked, disabled, keyboard, t, toggleCommandMenu } = props
  // 发送锁定期间，原生输入栏仍按取消权限处理活动轮次的 Stop。
  const canStop = props.useSession(state => state.running && Boolean(state.live.activeTurnId) && !composerUnavailable(state))
  const archived = props.useSession(state => state.archived)
  const plan = props.useProjection('plan', value => value?.active)
  const goal = useSyncExternalStore(goalDraft.subscribe, goalDraft.getSnapshot)
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
  const withSkillHint = text => `${text}, ${skillHint}`
  const placeholder = goal && !blocked && !disabled ? composerT('goalPlaceholder')
    : !blocked && !disabled && props.variant === 'hero' && props.placeholder === t('placeholder.hero')
    ? (plan ? t('placeholder.plan') : withSkillHint(props.placeholder)) : props.placeholder
  return <Native {...props} placeholder={placeholder} stop={canStop ? props.stop : undefined}
    t={(key, ...args) => {
      if (key === 'input.commands' && toggleCommandMenu) return commandsLabel
      if (goal && (key === 'input.send' || key.startsWith('input.send.'))) return composerT(archived ? 'goalUnarchiveAndSend' : 'goalSend')
      if (key === 'input.send' && archived) return unarchiveLabel
      if (key === 'placeholder.default') return withSkillHint(t(key, ...args))
      return t(key, ...args)
    }} />
}

function composerUnavailable(state) {
  const { openState } = state
  return state.removed || !allowsDirectInput(state) ? 'readonly'
    : openState === 'loading' ? 'loading' : openState !== 'open' ? 'unavailable' : undefined
}

function ContinueQueue({ useSession, useProjection, startQueue, t }) {
  const archived = useSession(state => state.archived)
  const ready = useSession(state => !composerUnavailable(state) && ['idle', 'notLoaded'].includes(state.live.status?.type))
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
  }}>{t(archived ? 'unarchiveAndContinue' : 'continueQueue')}</Button>
}

/** DSH 的地址模式用于路由。只读提示需要保留 Codex 明确拒绝与能力缺失的区别。 */
function adaptSubagentNotice(scope, translate) {
  let native
  let restore
  function sync() {
    const entry = scope.slots.entries(composer).find(entry => entry.locale === 'subagent')
    if (entry === native) return
    restore?.()
    native = entry
    restore = undefined
    const Native = entry?.component
    if (!Native) return
    function CodexSubagentNotice({ session, matched, t, ...props }) {
      const denied = matched.reason === 'unknown' && session?.canAcceptDirectInput === false
      const capabilityMissing = matched.reason === 'unknown' && session?.openState === 'open' && session.canAcceptDirectInput == null
      return <Native {...props} session={session} matched={matched} t={(key, ...args) => {
        if (denied && key === 'readonly.title') return translate('subagentReadonly')
        if (denied && key === 'readonly.unknown.body') return translate('subagentReadonlyBody')
        if (capabilityMissing && key === 'readonly.unknown.body') return translate('subagentCapabilityUnknown')
        return t(key, ...args)
      }} />
    }
    entry.component = CodexSubagentNotice
    restore = () => { if (entry.component === CodexSubagentNotice) entry.component = Native }
  }
  const unsubscribe = scope.on('slots/changed', name => { if (name === composer) sync() })
  sync()
  return () => { unsubscribe(); restore?.() }
}

/** 原生编辑器负责发送手势和草稿。停止后，可在原生队列下方手动继续。 */
export function installComposer(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.effect(() => {
    // 发送时先隐藏文本。把草稿和选区留给原生编辑器，失败时可原样继续编辑。
    const style = document.createElement('style')
    style.textContent = '[data-composer-card] [data-composer-input][data-phase="sending"] { opacity: 0; }'
    document.head.append(style)
    return () => style.remove()
  })
  const t = ctx.locale.bind(locale)
  installQueueImages(ctx)

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
              const state = session.getSnapshot()
              // 模式写入确认前锁定原生发送入口，避免同一份草稿被送到错误的模式。
              const reason = composerUnavailable(state) ?? (state.planChanging ? 'changingPlan' : undefined)
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
    scope.effect(() => adaptSubagentNotice(scope, t))
    scope.slots.inject(dock, () => scope.slots.register({
      name: dock, id: 'codex-continue-queue', order: 50, locale,
      inject: sessionId => ({ startQueue: scope.sessions.binding(sessionId)?.session.startQueue }),
    }, ContinueQueue))
  })

  ctx.effect(() => {
    const content = 'main.conversation'
    let current
    let restore
    function sync() {
      const entry = ctx.slots.entries(content)[0]
      if (entry === current) return
      restore?.()
      current = entry
      const Native = entry?.component
      if (!Native) return
      function Content(props) {
        // 选择另一工作区时打开它自己的新会话，保留原输入栏的草稿。
        const openWorkspace = isLocalSessionId(props.sessionId)
          ? workspaceId => props.openWorkspace(workspaceId)
          : props.openWorkspace
        return <Native {...props} openWorkspace={openWorkspace} />
      }
      entry.component = Content
      restore = () => { if (entry.component === Content) entry.component = Native }
    }
    const stop = ctx.on('slots/changed', name => { if (name === content) sync() })
    sync()
    return () => { stop(); restore?.() }
  })

  ctx.inject(['conversation', 'sessions'], scope => scope.effect(() => {
    const { conversation, sessions } = scope
    const rebindDraftFiles = conversation.rebindDraftFiles
    // 工作区切换也要沿用内嵌图片路径，避免原生输入栏尝试向 DSH 暂存 Codex 草稿。
    const rebindImages = function (sessionId, ids, uploadImages) {
      return rebindDraftFiles.call(this, sessionId, ids, sessions.binding(sessionId) ? false : uploadImages)
    }
    conversation.rebindDraftFiles = rebindImages
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
      const injectComposer = (sessionId, ...args) => {
        const props = inject(sessionId, ...args)
        if (sessionId === undefined) return props
        const binding = sessions.binding(sessionId)
        return { ...props, goalDraft: binding?.session.goalDraft, addFiles(files, directories) {
          if (!sessions.binding(sessionId)) return t('fileInputUnavailable')
          if (directories?.size) return t('filesOnly')
          // DSH 会暂存普通文件。图片草稿仍由原生组件在提交时编码。
          const drafts = conversation.createDrafts(sessionId, files, false)
          if (props.keyboard.addFiles([], drafts.map(draft => draft.id))) return null
          conversation.releaseDraftAttachments(drafts)
          return t('fileInputUnavailable')
        } }
      }
      function Composer(props) {
        const status = useSyncExternalStore(catalog.subscribe, () => props.sessionId === undefined ? catalog.getSnapshot() : undefined)
        const accessory = status?.error ? <p role="alert">{status.error}</p> : props.accessory
        return <ComposerBar {...props} accessory={accessory} Native={Component} commandsLabel={t('commands')} unarchiveLabel={t('unarchiveAndSend')}
          skillHint={t('skillHint')} composerT={t} />
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
      if (conversation.rebindDraftFiles === rebindImages) conversation.rebindDraftFiles = rebindDraftFiles
    }
  }))
}
