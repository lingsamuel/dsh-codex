import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { observe, projectCatalog, remoteFailure } from './catalog.js'
import { createCodexHistory } from './session-events.js'

const searchResultLimit = 20
const emptyProjection = { getSnapshot: () => undefined, subscribe: () => () => {} }
const unsupported = '当前页面仅支持浏览 Codex 历史。'

async function rejectWrite() {
  throw new Error(unsupported)
}

function readonlyBinding(ctx, thread) {
  const history = createCodexHistory(ctx, thread)
  return {
    ctx,
    sessionId: thread.id,
    eventSource: history.events,
    ready: history.ready,
    session: {
      ...history.session,
      projections: { faceOf: () => emptyProjection },
    },
  }
}

/** 仅安装浏览所需的客户端控制器。选择与保留引用都留在当前页面。 */
export function provideCodexControllers(ctx, catalog) {
  const projected = observe(catalog.store, projectCatalog)
  const list = createSnapshotStore({ ...projected.getSnapshot().sessions, phase: 'pending' })
  let initialization = 'waiting'
  const bindings = new Map()
  const retention = new Map()
  const scopeId = Symbol('Codex session')

  function syncSessions() {
    const snapshot = projected.getSnapshot().sessions
    list.set(initialization === 'ready' ? snapshot : { ...snapshot, phase: 'pending' })
  }

  function retainInfo(id) {
    if (!retention.has(id)) {
      retention.set(id, createSnapshotStore({ referenceCount: 0, retainedBy: {} }))
    }
    return retention.get(id)
  }

  const sessions = {
    list,
    binding: id => bindings.get(id)?.binding,
    scope: id => bindings.get(id)?.binding.ctx,
    scopeOf: scope => scope[scopeId],
    sessionOf: scope => bindings.get(scope[scopeId])?.binding.session,
    retainInfo,
    subagentAddress: () => undefined,
    searchResultLimit,
    async search() {
      // 侧栏原生搜索同时匹配本地标题与路径。当前 Codex API 没有正文搜索入口。
      return { ok: true, value: { items: [], hasMore: false } }
    },
    retain(id, { source }) {
      const thread = catalog.store.getSnapshot().threads.find(item => item.id === id)
      if (!thread) throw new Error(`找不到 Codex 会话 ${id}`)
      let record = bindings.get(id)
      if (!record) {
        const fiber = ctx.plugin(() => {})
        record = { binding: readonlyBinding(fiber.ctx.extend({ [scopeId]: id }), thread), fiber }
        bindings.set(id, record)
      }
      const { binding } = record
      const observer = retainInfo(id)
      observer.update(state => {
        state.referenceCount++
        state.retainedBy[source] = (state.retainedBy[source] ?? 0) + 1
      })
      if (source === 'mainView') catalog.select(thread)
      let released = false
      function release() {
        if (released) return
        released = true
        observer.update(state => {
          state.referenceCount--
          if (--state.retainedBy[source] === 0) delete state.retainedBy[source]
        })
        const info = observer.getSnapshot()
        if (source === 'mainView' && !info.retainedBy.mainView && catalog.store.getSnapshot().selected?.id === id) {
          catalog.select(null)
        }
        if (info.referenceCount === 0) {
          bindings.delete(id)
          void record.fiber.dispose()
        }
      }
      return { sessionId: id, binding, ready: binding.ready.then(() => binding), release, [Symbol.dispose]: release }
    },
    create: rejectWrite,
    fork: rejectWrite,
    using: async () => ({ ok: false, error: remoteFailure(unsupported) }),
  }
  const workspaces = {
    list: observe(projected, state => state.workspaces),
    initializeDefault: async () => undefined,
    create: rejectWrite,
    rename: rejectWrite,
    delete: rejectWrite,
    insertBefore: rejectWrite,
    archiveSession: rejectWrite,
    unarchiveSession: rejectWrite,
    pinSession: rejectWrite,
    unpinSession: rejectWrite,
  }

  ctx.provide('sessions', sessions)
  ctx.provide('workspaces', workspaces)
  ctx.provide('fileUpload', { upload: rejectWrite })
  ctx.effect(() => catalog.store.subscribe(syncSessions))
  ctx.inject(['uiWorkspace'], scope => {
    scope.effect(() => {
      function initialize() {
        const { busy, error, selected, threads } = catalog.store.getSnapshot()
        if (initialization !== 'waiting' || busy || error) return
        // DSH 在两个列表就绪后恢复主视图。先打开已有会话，让它无需补建空白会话。
        initialization = 'opening'
        const thread = selected ?? threads[0]
        if (thread) scope.uiWorkspace.openSession(thread.id)
        initialization = 'ready'
        syncSessions()
      }
      initialize()
      return catalog.store.subscribe(initialize)
    })
  })
}
