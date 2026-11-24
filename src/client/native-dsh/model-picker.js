import { createElement } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { readPage, writeThreadAction } from '../api.js'
import { remoteFailure } from './catalog.js'
import { installModelDefaultSettings } from './model-default-settings.jsx'
import { replaceMethod } from './replace-method.js'

const modelSlot = 'conversation.input.model'

function canChangeModel({ live, subagent, canAcceptDirectInput }) {
  return !subagent && canAcceptDirectInput !== false
    && live.mode !== 'connecting' && live.mode !== 'disconnected'
    && ['notLoaded', 'idle', 'active'].includes(live.status?.type)
}

function filterDirectory(directory, session) {
  let source
  let scope
  let visible
  return {
    subscribe(listener) {
      const fromDirectory = directory.subscribe(listener)
      const fromSession = session.subscribe(listener)
      const fromDraft = session.modelDraft.subscribe(listener)
      const fromModel = session.projections.faceOf('modelSelection').subscribe(listener)
      return () => { fromDirectory(); fromSession(); fromDraft(); fromModel() }
    },
    getSnapshot() {
      const catalog = directory.getSnapshot()
      const editable = canChangeModel(session.getSnapshot())
      const saved = session.projections.faceOf('modelSelection').getSnapshot()?.next
      const current = (editable ? session.modelDraft.getSnapshot() : undefined) ?? saved ?? (editable ? catalog.current : null)
      const provider = current?.provider
      const nextScope = `${provider}:${editable}`
      if (catalog !== source || nextScope !== scope || current !== visible?.current) {
        source = catalog
        scope = nextScope
        let groups = catalog.groups.filter(group => group.id === provider)
        if (current && (!editable || !groups.some(group => group.models.some(model => model.id === current.model)))) {
          const group = groups[0]
          const existing = group?.models.find(model => model.id === current.model)
          const selected = { id: current.model, name: existing?.name ?? current.model }
          groups = [{ id: provider, name: group?.name ?? provider, models: editable ? [selected, ...group?.models ?? []] : [selected] }]
        }
        visible = { ...catalog, current, groups, retainedEffort: editable ? catalog.retainedEffort : saved?.reasoningEffort,
          failures: catalog.failures.filter(failure => failure.id === provider) }
      }
      return visible
    },
  }
}

/** 复用 DSH 模型菜单，目录和会话设置均来自 Codex。 */
export function installModelPicker(ctx, signal) {
  const modelCatalog = createSnapshotStore({ value: null, error: '' })
  let pendingCatalog
  // 设置切页不应取消输入栏或其他设置行正在等待的全局目录。
  function loadModelCatalog() {
    pendingCatalog ??= readPage('models', {}, signal).then(value => {
      if (!signal.aborted) modelCatalog.set({ value, error: '' })
      return { ok: true, value }
    }, error => {
      if (!signal.aborted) modelCatalog.update(state => { state.error = error.message })
      return { ok: false, error: remoteFailure(error.message) }
    }).finally(() => { pendingCatalog = undefined })
    return pendingCatalog
  }
  installModelDefaultSettings(ctx, signal, modelCatalog, loadModelCatalog)
  ctx.inject(['remote', 'remote.session', 'sessions'], scope => {
    scope.effect(() => {
      const remote = scope.remote.session
      const restoreCatalog = replaceMethod(remote, 'modelCatalog', loadModelCatalog)
      const selectModel = replaceMethod(remote, 'selectModel', async ({ sessionId, provider, model, reasoningEffort }) => {
        const session = scope.sessions.binding(sessionId)?.session
        const state = session?.getSnapshot()
        if (!state || !canChangeModel(state)) {
          return { ok: false, error: remoteFailure('此会话当前无法选择模型。') }
        }
        if (state.localDraft || state.archived || state.live.status.type === 'notLoaded') {
          const selected = { provider, model, reasoningEffort }
          session.modelDraft.set(selected)
          return { ok: true, value: { selected } }
        }
        const draft = session.modelDraft.getSnapshot()
        try {
          const projection = session.projections.faceOf('modelSelection')
          const before = projection.getSnapshot()
          const { selection } = await writeThreadAction({ action: 'model', threadId: sessionId, provider, model, reasoningEffort }, signal)
          session.modelDraft.clear(draft)
          if (selection && scope.sessions.binding(sessionId)?.session === session && projection.getSnapshot() === before) {
            session.publishModel(selection)
          }
          return { ok: true, value: { selected: selection } }
        } catch (error) {
          return { ok: false, error: remoteFailure(error.message) }
        }
      })
      return () => { selectModel(); restoreCatalog() }
    })
  })

  ctx.inject(['commandUi'], scope => {
    scope.effect(() => {
      const commands = scope.commandUi
      const register = commands.register.bind(commands)
      // 原生模型插件同时注册 /model。这里保留输入栏已有入口。
      return replaceMethod(commands, 'register', command => command.name === 'model' ? () => {} : register(command))
    })
  })

  ctx.inject(['sessions'], scope => {
    scope.effect(() => {
      let entry
      let restore
      function sync() {
        const next = scope.slots.entries(modelSlot)[0]
        if (next === entry) return
        restore?.()
        entry = next
        restore = undefined
        const inject = entry?.inject
        const NativePicker = entry?.component
        if (!inject || !NativePicker) return
        const picker = (sessionId, ...args) => {
          const original = inject(sessionId, ...args)
          const session = scope.sessions.binding(sessionId)?.session
          if (!session) return original
          const directory = filterDirectory(original.directory, session)
          return { ...original, directory, select: selection => {
            const group = directory.getSnapshot().groups.find(group => group.id === selection.provider)
            const defaultEffort = group?.models.find(model => model.id === selection.model)?.reasoning?.defaultEffort
            // RC2 的鼠标模型行只传模型 ID，沿用原生目录的默认等级以匹配键盘选择。
            const reasoningEffort = selection.reasoningEffort ?? defaultEffort
            return original.select({ ...selection, ...(reasoningEffort != null && { reasoningEffort }) })
          } }
        }
        function Picker(props) {
          const editable = props.useSession(canChangeModel)
          return createElement(NativePicker, { ...props, locked: props.locked || !editable })
        }
        entry.inject = picker
        entry.component = Picker
        restore = () => {
          if (next.inject === picker) next.inject = inject
          if (next.component === Picker) next.component = NativePicker
        }
      }
      const unsubscribe = scope.on('slots/changed', name => { if (name === modelSlot) sync() })
      sync()
      return () => { unsubscribe(); restore?.() }
    })
  })
  return { modelCatalog, loadModelCatalog }
}
