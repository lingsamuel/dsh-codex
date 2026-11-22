import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement } from 'react'
import { readPage, writePermissionAction } from '../api.js'
import { remoteFailure } from './catalog.js'
import { permissionOptionValue } from '../../shared/permissions.js'

const locale = 'codex.permissions'
const follow = 'follow-codex'
const labels = {
  zh: {
    follow: '跟随 Codex', unknown: '权限未确认', custom: '自定义权限', saved: '上次记录：{mode}', requested: '已提交，首轮确认：{mode}',
    defaultDescription: '仅用于从此网页新建的 Codex 会话。', unavailable: '所选默认权限不再可用。',
    draft: '发送或继续队列时应用：{mode}',
    sandbox: '沙箱：{mode}', approval: '审批：{policy}', readOnly: '仅可查看', workspaceWrite: '工作区内修改',
    dangerFullAccess: '完全权限', externalSandbox: '外部沙箱', 'on-request': '按需', untrusted: '不受信时', never: '从不', granular: '按类别',
    managed: '托管沙箱', reviewer: '审批人：{name}', user: '用户', auto_review: '自动审查', guardian_subagent: '审查子代理',
    subsequent: '后续轮次 · {details}',
    command: '权限', commandDescription: '查看本轮权限或切换下轮预设',
    currentTurn: '本轮权限 · {mode}', nextTurn: '下轮权限', unconfirmed: '未确认',
    sessionFullAccess: '完全权限会为此会话的后续轮次解除 Codex 沙箱限制。审批继续由该会话的 Codex 策略决定。',
    defaultFullAccess: '从此网页新建的会话将使用 Codex 完全权限预设并解除沙箱限制。审批方式由 Codex 配置决定。',
  },
  en: {
    follow: 'Follow Codex', unknown: 'Permission unconfirmed', custom: 'Custom permissions', saved: 'Last saved: {mode}', requested: 'Submitted for first turn: {mode}',
    defaultDescription: 'Applies only to new Codex sessions created from this web interface.', unavailable: 'The saved default is no longer selectable.',
    draft: 'Apply on send or queue start: {mode}',
    sandbox: 'Sandbox: {mode}', approval: 'Approval: {policy}', readOnly: 'Read Only', workspaceWrite: 'Workspace Write',
    dangerFullAccess: 'Full Access', externalSandbox: 'External Sandbox', 'on-request': 'On request', untrusted: 'When untrusted', never: 'Never', granular: 'By category',
    managed: 'Managed sandbox', reviewer: 'Reviewer: {name}', user: 'User', auto_review: 'Auto review', guardian_subagent: 'Review subagent',
    subsequent: 'Subsequent turns · {details}',
    command: 'Permissions', commandDescription: 'View current turn permissions or change the next turn preset',
    currentTurn: 'Current turn permissions · {mode}', nextTurn: 'Next turn permissions', unconfirmed: 'Unconfirmed',
    sessionFullAccess: 'Full access removes Codex sandbox restrictions for subsequent turns of this session. Codex continues to apply the session’s approval policy.',
    defaultFullAccess: 'New sessions created from this web interface will use Codex Full access without sandbox restrictions. Codex configuration determines approvals.',
  },
}
const sandboxNames = {
  readOnly: 'readOnly', 'read-only': 'readOnly', workspaceWrite: 'workspaceWrite', 'workspace-write': 'workspaceWrite',
  dangerFullAccess: 'dangerFullAccess', 'danger-full-access': 'dangerFullAccess', externalSandbox: 'externalSandbox', 'external-sandbox': 'externalSandbox',
  managed: 'managed', disabled: 'dangerFullAccess', external: 'externalSandbox',
}
const profileNames = { ':read-only': 'readOnly', ':workspace': 'workspaceWrite', ':danger-full-access': 'dangerFullAccess' }
const pickerStyle = { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }
const turnLabelStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, whiteSpace: 'nowrap' }
const currentTurnLabelStyle = { ...turnLabelStyle, overflow: 'hidden', textOverflow: 'ellipsis' }

function pickerOption(profile) {
  const value = permissionOptionValue(profile.id)
  return { value, name: value === `codex:${profile.id}` ? profile.id : value, ...profile }
}

function nativeCatalog(snapshot, t) {
  const options = snapshot.profiles.map(pickerOption)
  return {
    options, defaultOptions: [{ value: follow, name: t('follow') }, ...options],
    defaultPreset: snapshot.defaultProfile == null ? follow : permissionOptionValue(snapshot.defaultProfile),
  }
}

function permissionLabel(permission, t) {
  const key = permission.profileId
    ? (Object.hasOwn(profileNames, permission.profileId) ? profileNames[permission.profileId] : undefined)
    : sandboxNames[permission.sandbox]
  return (key && t(key)) || permission.profileId || t('custom')
}

function effectiveLabel(permission, t) {
  if (!permission) return t('unknown')
  const label = permissionLabel(permission, t)
  return permission.source === 'runtime' ? label : t(permission.source, { mode: label })
}

function details(permission, t, heading) {
  if (!permission) return t('unknown')
  const sandbox = permission.sandbox && (sandboxNames[permission.sandbox] ? t(sandboxNames[permission.sandbox]) : permission.sandbox)
  const approval = permission.approvalPolicy
  const reviewer = permission.approvalsReviewer
  return [heading ?? (permission.source !== 'runtime' && effectiveLabel(permission, t)), sandbox && t('sandbox', { mode: sandbox }),
    approval && t('approval', { policy: Object.hasOwn(labels.en, approval) ? t(approval) : approval }),
    reviewer && t('reviewer', { name: Object.hasOwn(labels.en, reviewer) ? t(reviewer) : reviewer })].filter(Boolean).join(' · ')
}

function canSelect(state) {
  return state.openState === 'open' && !state.subagent && state.canAcceptDirectInput !== false
    && ['idle', 'active', 'notLoaded'].includes(state.live?.status?.type)
}

function adaptSlot(ctx, slot, find, adapt) {
  return ctx.effect(() => {
    let entry
    let restore
    function sync() {
      const next = ctx.slots.entries(slot).find(find)
      if (entry === next) return
      restore?.()
      entry = next
      restore = undefined
      if (!entry?.component || !entry.inject) return
      const { inject, component } = entry
      const replacement = adapt(inject, component)
      entry.inject = replacement.inject
      entry.component = replacement.component
      restore = () => {
        if (next.inject === replacement.inject) next.inject = inject
        if (next.component === replacement.component) next.component = component
      }
    }
    const stop = ctx.on('slots/changed', name => { if (slot === name) sync() })
    sync()
    return () => { stop(); restore?.() }
  })
}

function PermissionError({ usePermissionError, dismiss }) {
  const error = usePermissionError(value => value)
  return error && createElement(Toast, { key: error.id, tone: 'error', text: error.message, onDone: () => dismiss(error) })
}

/** 复用 DSH 的权限控件和风险确认，目录与会话权限都以 Codex 的回答为准。 */
export function installPermissions(ctx, catalog, signal) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  const directory = createSnapshotStore({ value: null })
  const defaults = createSnapshotStore({ status: 'idle', error: null, writable: false, options: [], currentValue: '', revision: 0 })
  const errorStore = createSnapshotStore(null)
  const emptyDraft = createSnapshotStore(undefined)
  const pickers = new Map()
  let errorId = 0
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'codex-permission-error', locale,
    inject: () => ({ hooks: { permissionError: errorStore }, dismiss: error => {
      if (errorStore.getSnapshot() === error) errorStore.set(null)
    } }),
  }, PermissionError))

  let defaultDirectory
  function publishDefaults(snapshot) {
    defaultDirectory = nativeCatalog(snapshot, t)
    const { defaultPreset, defaultOptions } = defaultDirectory
    defaults.set({ status: 'ready', writable: true, revision: 0, currentValue: defaultPreset,
      options: defaultOptions.map(option => ({ id: option.value, label: option.name })),
      error: defaultOptions.some(option => option.value === defaultPreset) ? null : t('unavailable') })
  }
  function defaultError(error) {
    if (signal.aborted) return
    defaults.update(state => { state.status = 'error'; state.error = error.message })
  }
  async function load() {
    defaults.update(state => { state.status = 'loading'; state.error = null })
    try { publishDefaults(await readPage('permissions', {}, signal)) }
    catch (error) { defaultError(error) }
  }
  async function selectDefault(value) {
    if (defaults.getSnapshot().status === 'saving') return
    const profileId = value === follow ? null : defaultDirectory?.options.find(option => option.value === value)?.id
    if (profileId === undefined) return
    defaults.update(state => { state.status = 'saving'; state.error = null })
    try {
      await writePermissionAction({ action: 'default', profileId }, signal)
      await load()
    } catch (error) { defaultError(error) }
  }

  ctx.inject(['connection', 'remote.permissionPresets', 'sessions'], scope => scope.effect(() => {
    const remote = scope.get('remote.permissionPresets')
    const original = Object.getOwnPropertyDescriptor(remote, 'catalog')
    async function readCatalog() {
      try { return { ok: true, value: nativeCatalog(await readPage('permissions', {}, signal), t) } }
      catch (error) { return { ok: false, error: remoteFailure(error.message) } }
    }
    Object.defineProperty(remote, 'catalog', { configurable: true, enumerable: true, value: readCatalog })
    let threadId
    let controller
    let initial = true
    function refreshCurrent(force = false) {
      const id = catalog.getSnapshot().selected?.id
      if (!initial && threadId === id && !force) return
      initial = false
      threadId = id
      controller?.abort()
      directory.set({ value: null })
      if (!id) return
      controller = new AbortController()
      const requestSignal = AbortSignal.any([signal, controller.signal])
      const session = scope.sessions.binding(id)?.session
      const before = session?.projections.faceOf('permissions').getSnapshot()
      void readPage('permissions', { threadId: id }, requestSignal).then(snapshot => {
        if (requestSignal.aborted) return
        directory.set({ value: nativeCatalog(snapshot, t) })
        // HTTP 缓存可能比线程的通知或原生历史更早，仅补齐缺失的权限状态。
        if (snapshot.permission && !before?.permission && session?.projections.faceOf('permissions').getSnapshot() === before) {
          session?.publishPermission(snapshot.permission)
        }
      }).catch(error => {
        if (!requestSignal.aborted) errorStore.set({ id: ++errorId, message: error.message })
      })
    }
    const stop = catalog.subscribe(() => refreshCurrent())
    const stopGeneration = scope.connection.generation.subscribe(() => refreshCurrent(true))
    refreshCurrent()
    return () => {
      stop()
      stopGeneration()
      controller?.abort()
      if (Object.getOwnPropertyDescriptor(remote, 'catalog')?.value !== readCatalog) return
      if (original) Object.defineProperty(remote, 'catalog', original)
      else Reflect.deleteProperty(remote, 'catalog')
    }
  }))

  ctx.inject(['sessions', 'commandUi'], scope => scope.effect(() => scope.commandUi.register({
    name: 'permissions', label: () => t('command'), description: () => t('commandDescription'),
    available({ sessionId }) {
      const state = scope.sessions.binding(sessionId)?.session.getSnapshot()
      return Boolean(state && canSelect(state) && directory.getSnapshot().value)
    },
    ui: {
      kind: 'action',
      run({ sessionId }) {
        const roots = [...pickers].filter(([root, id]) => id === sessionId && root.isConnected).map(([root]) => root)
        const composer = roots[0]?.ownerDocument.activeElement?.closest('[data-composer-card]')
        const root = roots.find(candidate => composer?.contains(candidate)) ?? roots[0]
        // 打开当前输入栏的原生菜单，沿用其选中、键盘导航与风险确认。
        const button = root?.querySelector('button')
        if (!button || button.disabled) return
        button.focus({ preventScroll: true })
        button.click()
      },
    },
  })))

  ctx.inject(['sessions'], scope => adaptSlot(scope, 'conversation.input.permission', entry => entry.locale === 'permission.access', (inject, Native) => ({
    inject: (sessionId, ...args) => {
      const props = inject(sessionId, ...args)
      const permissionDraft = scope.sessions.binding(sessionId)?.session.permissionDraft ?? emptyDraft
      let picker
      function attachPicker(root) {
        pickers.delete(picker)
        picker = root
        if (root) pickers.set(root, sessionId)
      }
      return { ...props, attachPicker, hooks: { ...props.hooks, permissionCatalog: directory, permissionDraft }, async select(value) {
        const session = scope.sessions.binding(sessionId)?.session
        const target = directory.getSnapshot().value?.options.find(option => option.value === value)
        const state = session?.getSnapshot()
        if (!state || !target || !canSelect(state)) return false
        if (state.archived) {
          session.permissionDraft.set(target.id)
          return true
        }
        const stored = session.permissionDraft.getSnapshot()
        const before = session.projections.faceOf('permissions').getSnapshot()
        try {
          const { permission } = await writePermissionAction({ action: 'select', threadId: sessionId, profileId: target.id }, signal)
          session.permissionDraft.clear(stored)
          if (scope.sessions.binding(sessionId)?.session === session && session.projections.faceOf('permissions').getSnapshot() === before) {
            session.publishPermission(permission)
          }
          return true
        } catch (error) {
          if (!signal.aborted) errorStore.set({ id: ++errorId, message: error.message })
          return false
        }
      } }
    },
    component: function PermissionSelect({ attachPicker, ...props }) {
      const projection = props.useProjection('permissions')
      const draft = props.usePermissionDraft(value => value)
      const editable = props.useSession(canSelect)
      const turn = props.useSession(state => state.running ? state.live.turnPermission ?? null : undefined)
      const current = draft ? { profileId: draft, source: 'draft' } : projection?.permission
      const available = props.usePermissionCatalog(state => state.value?.options)
      const value = current?.profileId && permissionOptionValue(current.profileId)
      const currentValue = current?.source === 'runtime' && available?.some(option => option.value === value)
        ? value : effectiveLabel(current, t)
      const summary = details(current, t)
      const title = current?.source === 'runtime' ? t('subsequent', { details: summary || effectiveLabel(current, t) }) : summary
      const running = turn !== undefined
      const turnLabel = running && t('currentTurn', { mode: turn ? permissionLabel(turn, t) : t('unconfirmed') })
      return createElement('span', { ref: attachPicker, style: { ...pickerStyle, flexWrap: 'wrap' } },
        running && createElement('span', { style: currentTurnLabelStyle, title: turn ? details(turn, t, turnLabel) : turnLabel }, turnLabel),
        createElement('span', { title, style: pickerStyle },
          running && createElement('span', { style: turnLabelStyle }, t('nextTurn')),
          createElement(Native, {
            ...props, locked: props.locked || !editable, useProjection: () => ({ currentValue }),
            t: (key, ...args) => key === 'confirm.description' ? t('sessionFullAccess') : props.t(key, ...args),
          })),
      )
    },
  })))

  adaptSlot(ctx, 'settings.general.item', entry => entry.options.id === 'permission', (inject, Native) => ({
    inject: (...args) => {
      const props = inject(...args)
      return { ...props, hooks: { ...props.hooks, permission: defaults }, load, select: selectDefault }
    },
    component: function DefaultPermission(props) {
      return createElement(Native, { ...props, t: (key, ...args) => {
        if (key === 'description') return t('defaultDescription')
        if (key === 'confirm.description') return t('defaultFullAccess')
        return props.t(key, ...args)
      } })
    },
  }))
}
