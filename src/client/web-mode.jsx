import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import pkg from '../../package.json' with { type: 'json' }
import { canKeepWebPage, webModeFor, webModePath } from '../shared/web-mode.js'
import { beginModeLoading, saveModeHandoff } from '../shared/web-mode-handoff.js'
import { installModeBrand, playModeBrand } from './native-dsh/mode-brand.jsx'
import { sessionLoadingCopy } from './native-dsh/startup.jsx'

const workspaceSlot = 'sidebar.workspaces'
const pluginSlot = 'plugins.bundle.config'
const locale = 'codex.webMode'
const copy = {
  zh: {
    mode: '启用 Codex 模式', switchDsh: '切换到 DSH', settings: 'Web 模式', exclusive: 'Codex 独占',
    exclusiveHelp: '所有标签页统一进入 Codex，隐藏侧栏模式开关。',
    coexist: '允许标签页使用不同模式', coexistHelp: '各标签页可通过地址选择 DSH 或 Codex。',
    openDsh: '在新标签页打开 DSH', openCodex: '在新标签页打开 Codex',
    reload: '重新加载', changed: '实例模式已改变，请重新加载当前页面。',
    unavailable: '无法读取 Web 模式设置。', submission: '请等待当前的提交完成。',
    switching: '正在切换模式…', loadingPlugins: '正在载入插件…',
    loadingSession: sessionLoadingCopy.zh.loading, loadingLayout: '正在准备工作区…',
    draft: '切换会放弃只保存在当前页面的编辑、模型选择或附件。是否继续？',
  },
  en: {
    mode: 'Enable Codex mode', switchDsh: 'Switch to DSH', settings: 'Web mode', exclusive: 'Codex only',
    exclusiveHelp: 'Open every tab in Codex and hide the sidebar mode switch.',
    coexist: 'Allow different modes in each tab', coexistHelp: 'Use the address to open DSH or Codex in individual tabs.',
    openDsh: 'Open DSH in a new tab', openCodex: 'Open Codex in a new tab',
    reload: 'Reload', changed: 'The instance mode changed. Reload this page to continue.',
    unavailable: 'Could not read Web mode settings.', submission: 'Wait for the current submission to finish.',
    switching: 'Switching mode…', loadingPlugins: 'Loading plugins…',
    loadingSession: sessionLoadingCopy.en.loading, loadingLayout: 'Preparing the workspace…',
    draft: 'Switching will discard edits, model choices, or attachments kept only in this page. Continue?',
  },
}

const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const settingsRow = { ...row, gap: 16, padding: '10px 0', borderBlockEnd: '1px solid var(--dsw-alias-border-l2)' }
const description = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5, margin: '2px 0 0' }

function leaveBlock(ctx, hasModelDraft) {
  if (document.querySelector('[data-codex-pending-edit]')) return 'submission'
  let unsaved = hasModelDraft?.() || Boolean(document.querySelector('[data-codex-unsaved-edit], [data-queue-dock] textarea'))
  const sessions = ctx.get('sessions')
  const conversation = ctx.get('conversation')
  for (const id of Object.keys(sessions?.list.getSnapshot().byId ?? {})) {
    const binding = sessions.binding(id)
    if (!binding) continue
    const input = conversation?.input.for(binding.ctx).state.getSnapshot()
    if (input?.phase && input.phase !== 'plain' && input.phase !== 'claimed') return 'submission'
    if (input?.attachmentIds.length || binding.session.modelDraft?.getSnapshot()) unsaved = true
  }
  return unsaved ? 'draft' : undefined
}

function SidebarMode({ wide, state, change, t }) {
  const { available, exclusive, mode, pending, error, stale } = useSyncExternalStore(state.subscribe, state.getSnapshot)
  const label = t('mode')
  return <>
    {available && !exclusive && !stale && <div style={{ ...row, padding: '6px 12px', justifyContent: wide ? 'space-between' : 'center' }}>
      {wide && <span>{label}</span>}
      <Switch checked={mode === 'codex'} disabled={pending} label={label} title={label}
        onChange={value => change('defaultMode', value ? 'codex' : 'dsh')} />
    </div>}
    {(error || !available) && <div role="status" style={{ padding: '6px 12px', overflowWrap: 'anywhere' }}>
      {error || t('unavailable')}
      {!available && <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>{t('reload')}</Button>}
    </div>}
  </>
}

function ModeChanged({ state, reload, t }) {
  const { error, stale } = useSyncExternalStore(state.subscribe, state.getSnapshot)
  if (!stale) return null
  return <Modal open title={t('mode')} description={error || t('changed')} closeLabel={t('reload')} onClose={reload}
    footer={<Button size="sm" variant="primary" onClick={reload}>{t('reload')}</Button>} />
}

function entryUrl(mode) {
  const url = new URL('./', document.baseURI)
  url.searchParams.set('mode', mode)
  return url.href
}

function ModeSettings({ state, change, t }) {
  const { available, coexist, exclusive, pending, error, stale } = useSyncExternalStore(state.subscribe, state.getSnapshot)
  return <div role="group" aria-label={t('settings')} style={{ minWidth: 0 }}>
    {[['coexist', coexist], ['exclusive', exclusive]].map(([field, value]) => <div key={field} style={settingsRow}>
      <div style={{ minWidth: 0, fontSize: 14, lineHeight: '20px', overflowWrap: 'anywhere' }}>
        <div>{t(field)}</div>
        <p id={`dsh-codex-${field}-help`} style={description}>{t(`${field}Help`)}</p>
      </div>
      <div style={{ flex: 'none' }}>
        <Switch checked={value} disabled={!available || pending || stale || field === 'coexist' && exclusive}
          label={t(field)} describedBy={`dsh-codex-${field}-help`} onChange={next => change(field, next)} />
      </div>
    </div>)}
    {coexist && !exclusive && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      {['dsh', 'codex'].map(mode => <Button key={mode} size="sm" variant="outline"
        onClick={() => window.open(entryUrl(mode), '_blank', 'noopener')}>
        {t(mode === 'codex' ? 'openCodex' : 'openDsh')}
      </Button>)}
    </div>}
    {error && <p role="alert" style={{ ...description, color: 'var(--dsw-alias-label-error)' }}>{error}</p>}
  </div>
}

/** 在工作区插槽前添加开关，沿用原工作区的控制器、Store 和子插槽。 */
function installSidebarMode(ctx, state, change, t) {
  ctx.effect(() => {
    let current
    let restore
    function sync() {
      const entry = ctx.slots.entriesOfSlot(workspaceSlot)[0]
      if (entry === current) return
      restore?.()
      current = entry
      restore = undefined
      const Workspace = entry?.component
      if (!Workspace) return
      function WorkspaceWithMode(props) {
        useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot())
        return <>
          <SidebarMode wide={props.wide} {...{ state, change, t }} />
          <Workspace {...props} />
        </>
      }
      entry.component = WorkspaceWithMode
      restore = () => { if (entry.component === WorkspaceWithMode) entry.component = Workspace }
    }
    const stop = ctx.slots.subscribe(workspaceSlot, sync)
    sync()
    return () => { stop(); restore?.() }
  })
}

/** 设置保存成功后，按确认的入口决定是否播放导航动画。 */
export function installWebMode(ctx, initial, hasModelDraft) {
  const action = new URL(webModePath.slice(1), document.baseURI)
  const state = createSnapshotStore(initial)
  const controller = new AbortController()
  const channel = typeof window.BroadcastChannel === 'function'
    ? new window.BroadcastChannel(`dsh-codex:web-mode:${webModePath}`) : undefined
  const refreshUrl = new URL(action)
  refreshUrl.searchParams.set('mode', initial.mode)
  const t = ctx.locale.bind(locale)
  let revision = 0
  let releaseInputs

  function holdInputs() {
    const { body, activeElement } = document
    const before = body.inert
    const suspension = new AbortController()
    body.inert = true
    const stopLoading = beginModeLoading(t('switching'))
    window.addEventListener('keydown', event => event.stopImmediatePropagation(), {
      capture: true, signal: suspension.signal,
    })
    releaseInputs = () => {
      suspension.abort()
      stopLoading()
      body.inert = before
      if (activeElement?.isConnected) activeElement.focus?.({ preventScroll: true })
      releaseInputs = undefined
    }
  }

  function publish(next) {
    const stale = next.available && next.mode !== initial.mode
    state.set({ ...next, stale })
  }

  async function refresh() {
    if (state.getSnapshot().pending) return
    const request = ++revision
    try {
      const response = await fetch(refreshUrl, { signal: controller.signal })
      if (response.status === 404 && request === revision) {
        state.set({ ...state.getSnapshot(), stale: true })
        return
      }
      if (!response.ok) return
      const next = await response.json()
      if (request === revision) publish({ error: state.getSnapshot().error, ...next })
    } catch {
      // 保留上次确认的状态，重新聚焦或收到下一次模式更新时再读取。
    }
  }

  async function change(field, value) {
    const current = state.getSnapshot()
    if (current.pending || current.stale || !current.available) return
    const patch = { [field]: value }
    const preferenceOnly = canKeepWebPage(current, patch)
    const switchTab = field === 'defaultMode'
    const leaving = (switchTab ? value : webModeFor({ ...current, ...patch }, current.mode)) !== current.mode
    if (leaving && !canLeave()) return
    ++revision
    state.set({ ...current, pending: true, error: undefined })
    if (leaving) holdInputs()
    let navigating = false
    try {
      const response = await fetch(refreshUrl, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, ...(preferenceOnly && { keepPage: true }) }) })
      const result = await response.json()
      if (response.status === 409 && result.mode) { publish(result); return }
      if (!response.ok) throw new Error(result.error || t('unavailable'))
      channel?.postMessage(null)
      const target = switchTab && result.coexist && !result.exclusive ? value : result.mode
      if (leaving && target !== current.mode) {
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          document.documentElement?.setAttribute('data-codex-mode-leaving', '')
          await playModeBrand(state, current, target)
        }
        if (!controller.signal.aborted) {
          const url = entryUrl(target)
          saveModeHandoff(url, {
            plugins: t('loadingPlugins'),
            session: t('loadingSession'),
            layout: t('loadingLayout'),
          })
          window.location.assign(url)
          navigating = true
        }
      } else {
        publish(result)
      }
    } catch (error) {
      document.documentElement?.removeAttribute('data-codex-mode-leaving')
      if (!controller.signal.aborted) state.set({ ...current, error: error.message })
    } finally {
      if (!navigating) releaseInputs?.()
    }
  }

  function canLeave() {
    const block = leaveBlock(ctx, hasModelDraft)
    if (block === 'submission') {
      state.set({ ...state.getSnapshot(), error: t('submission') })
      return false
    }
    return !block || window.confirm(t('draft'))
  }

  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.effect(() => {
    window.addEventListener('focus', refresh, { signal: controller.signal })
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return
      releaseInputs?.()
      document.documentElement?.removeAttribute('data-codex-mode-leaving')
      state.set({ ...state.getSnapshot(), pending: false, motion: undefined })
      void refresh()
    }, { signal: controller.signal })
    channel?.addEventListener('message', refresh, { signal: controller.signal })
    return () => {
      controller.abort()
      channel?.close()
      releaseInputs?.()
      document.documentElement?.removeAttribute('data-codex-mode-leaving')
    }
  })
  installSidebarMode(ctx, state, change, t)
  installModeBrand(ctx, state, change, t)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'codex-web-mode-changed', locale,
    inject: () => ({ state, reload: () => {
      if (canLeave()) window.location.reload()
    } }),
  }, ModeChanged))
  ctx.slots.inject(pluginSlot, () => ctx.slots.register({ name: pluginSlot, key: pkg.name, locale,
    inject: () => ({ state, change }),
  }, ModeSettings))
}
