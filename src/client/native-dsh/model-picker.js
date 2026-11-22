import { createElement } from 'react'
import { readPage, writeThreadAction } from '../api.js'
import { remoteFailure } from './catalog.js'

const modelSlot = 'conversation.input.model'

function replaceMethod(object, name, method) {
  const existing = Object.getOwnPropertyDescriptor(object, name)
  Object.defineProperty(object, name, { configurable: true, enumerable: true, value: method })
  return () => {
    if (Object.getOwnPropertyDescriptor(object, name)?.value !== method) return
    if (existing) Object.defineProperty(object, name, existing)
    else Reflect.deleteProperty(object, name)
  }
}

function canChangeModel({ archived, live, subagent, canAcceptDirectInput }) {
  return !archived && !subagent && canAcceptDirectInput !== false
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
  ctx.inject(['remote', 'remote.session', 'sessions'], scope => {
    scope.effect(() => {
      const remote = scope.remote.session
      const modelCatalog = replaceMethod(remote, 'modelCatalog', async () => {
        try {
          return { ok: true, value: await readPage('models', {}, signal) }
        } catch (error) {
          return { ok: false, error: remoteFailure(error.message) }
        }
      })
      const selectModel = replaceMethod(remote, 'selectModel', async ({ sessionId, provider, model, reasoningEffort }) => {
        const session = scope.sessions.binding(sessionId)?.session
        if (!session || !canChangeModel(session.getSnapshot())) {
          return { ok: false, error: remoteFailure('此会话当前无法选择模型。') }
        }
        if (session.getSnapshot().live.status.type === 'notLoaded') {
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
      return () => { selectModel(); modelCatalog() }
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
}
