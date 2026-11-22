import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { observe, projectCatalog, remoteFailure } from './catalog.js'
import { createCodexHistory } from './session-events.js'
import { subagentAddress } from './subagents.js'
import { writeThreadAction } from '../api.js'

const searchResultLimit = 20
const unsupported = '此操作暂未开放，请使用 Codex CLI。'

async function rejectWrite() {
  throw new Error(unsupported)
}

function readonlyBinding(ctx, thread, catalog) {
  const history = createCodexHistory(ctx, thread, catalog)
  const interactionUnavailable = async () => ({ ok: false, error: remoteFailure(unsupported) })
  return {
    ctx,
    sessionId: thread.id,
    eventSource: history.events,
    ready: history.ready,
    session: {
      ...history.session,
      prompt: interactionUnavailable,
      cancel: interactionUnavailable,
      updateQueue: interactionUnavailable,
      async rename(title) {
        try {
          await writeThreadAction({ threadId: thread.id, action: 'rename', name: title })
          return { ok: true, value: { title } }
        } catch (error) {
          return { ok: false, error: remoteFailure(error.message) }
        }
      },
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
    subagentAddress: id => subagentAddress(catalog.store.getSnapshot().childThreads[id]),
    refreshProjections: id => catalog.loadChildren(id, true),
    searchResultLimit,
    async search(query, signal) {
      try {
        return { ok: true, value: await catalog.search(query, signal) }
      } catch (error) {
        return { ok: false, error: remoteFailure(error.message) }
      }
    },
    retain(target, { source }) {
      const id = typeof target === 'string' ? target : target.childSessionId
      const { threads, childThreads } = catalog.store.getSnapshot()
      const thread = childThreads[id] ?? threads.find(item => item.id === id)
      if (!thread) throw new Error(`找不到 Codex 会话 ${id}`)
      let record = bindings.get(id)
      if (!record) {
        const fiber = ctx.plugin(() => {})
        record = { binding: readonlyBinding(fiber.ctx.extend({ [scopeId]: id }), thread, catalog), fiber }
        bindings.set(id, record)
        void catalog.loadChildren(id)
      }
      const { binding } = record
      const observer = retainInfo(id)
      observer.update(state => {
        state.referenceCount++
        state.retainedBy[source] = (state.retainedBy[source] ?? 0) + 1
      })
      if (source === 'mainView') catalog.select(thread, initialization !== 'opening')
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
    async using(target, options, operation) {
      const reference = sessions.retain(target, options)
      try {
        await reference.ready
        return await operation(reference)
      } finally {
        reference.release()
      }
    },
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
    pinSession: threadId => writeThreadAction({ threadId, action: 'pin', pinned: true }),
    unpinSession: threadId => writeThreadAction({ threadId, action: 'pin', pinned: false }),
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
        const thread = selected ?? threads.find(thread => !thread.archived) ?? threads[0]
        if (thread) scope.uiWorkspace.openSession(thread.id)
        initialization = 'ready'
        syncSessions()
      }
      initialize()
      return catalog.store.subscribe(initialize)
    })
  })
}
