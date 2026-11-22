import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { observe, projectCatalog, remoteFailure } from './catalog.js'
import { createCodexHistory } from './session-events.js'
import { createSessionInput } from './session-input.js'
import { subagentAddress } from './subagents.js'
import { writeConversationAction, writeThreadAction } from '../api.js'

const searchResultLimit = 20
const flatSessionOrderKey = '__flat_session_order__'
const unsupported = '此操作暂未开放，请使用 Codex CLI。'

async function rejectWrite() {
  throw new Error(unsupported)
}

function codexBinding(ctx, thread, catalog, modelDrafts) {
  const history = createCodexHistory(ctx, thread, catalog)
  const modelDraft = observe(modelDrafts, drafts => drafts.get(thread.id))
  function setDraft(selection) {
    const drafts = new Map(modelDrafts.getSnapshot())
    if (selection) drafts.set(thread.id, selection)
    else drafts.delete(thread.id)
    modelDrafts.set(drafts)
  }
  // 切换会话会释放历史绑定，草稿模型应和输入草稿一样仍可在返回时使用。
  const draft = { ...modelDraft, set: setDraft, clear(selection) {
    if (selection && modelDraft.getSnapshot() === selection) setDraft(undefined)
  } }
  return {
    ctx,
    sessionId: thread.id,
    eventSource: history.events,
    ready: history.ready,
    session: {
      ...history.session,
      ...createSessionInput(ctx, thread.id, history, draft),
      modelDraft: draft,
      sessionId: thread.id,
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

/** 为 DSH 提供 Codex 会话与工作区控制器。选择与保留引用都留在当前页面。 */
export function provideCodexControllers(ctx, catalog) {
  const projected = observe(catalog.store, projectCatalog)
  const list = createSnapshotStore({ ...projected.getSnapshot().sessions, phase: 'pending' })
  let initialization = 'waiting'
  const bindings = new Map()
  const retention = new Map()
  const modelDrafts = createSnapshotStore(new Map())
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
        record = { binding: codexBinding(fiber.ctx.extend({ [scopeId]: id }), thread, catalog, modelDrafts), fiber }
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
    async create({ workspaceId, cwd, sessionId } = {}) {
      const workspace = workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      const directory = cwd ?? workspace?.path
      if (!directory) throw new Error('请先选择新会话的工作目录。')
      const projectId = workspace?.workspaceId.startsWith('project:') ? workspace.workspaceId.slice('project:'.length) : undefined
      const summaries = list.getSnapshot().byId
      const reuseThreadId = sessionId ?? workspace?.sessionIds.find(id => summaries[id]?.blank)
      const { thread, workspacePaths } = await writeConversationAction({ action: 'create', cwd: directory, projectId, reuseThreadId })
      catalog.acceptThread(thread, workspacePaths)
      return thread.id
    },
    async fork({ sessionId: threadId, atSeq, onCreated }) {
      const lastTurnId = atSeq === undefined ? undefined : sessions.binding(threadId)?.session.turnAtEnd(atSeq)
      if (atSeq !== undefined && !lastTurnId) throw new Error('找不到可分支的 Codex 轮次。')
      const { thread, workspacePaths } = await writeThreadAction({ threadId, action: 'fork', lastTurnId })
      // DSH 的回复分支会立即打开新会话，必须先让保留引用能从原生目录找到它。
      catalog.acceptThread(thread, workspacePaths)
      const view = ctx.slots.entriesOfSlot('sidebar.workspaces')[0]?.store?.create()
      const viewState = view?.getSnapshot()
      if (viewState?.orderBy === 'manual') {
        const workspace = workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(thread.id))
        const orders = {}
        // 复用侧栏保存顺序的操作，置顶分区继续由 DSH 生成。
        for (const key of [workspace?.workspaceId ?? '', flatSessionOrderKey]) {
          const order = viewState.sessionOrderByAccount[key] ?? []
          orders[key] = [thread.id, ...order.filter(id => id !== thread.id)]
        }
        view.actions.syncSessionOrders(orders)
      }
      onCreated?.(thread.id)
      return thread.id
    },
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
    async create({ path }) {
      const existing = workspaces.list.getSnapshot().items.find(item => item.path === path)
      if (existing) return existing
      const { project, workspacePaths } = await writeConversationAction({ action: 'project', cwd: path })
      catalog.acceptProject(project, workspacePaths)
      return workspaces.list.getSnapshot().items.find(item => item.workspaceId === `project:${project.id}`)
    },
    rename: rejectWrite,
    delete: rejectWrite,
    insertBefore: rejectWrite,
    async archiveSession(threadId, { stopActivity } = {}) {
      try {
        await writeThreadAction({ threadId, action: 'archive', stopActivity })
      } catch (error) {
        if (error.reason !== 'archiveActive') throw error
        // 复用 DSH 对正在执行的会话显示的停止并归档确认。
        throw Object.assign(error, { name: 'WorkspaceArchiveError',
          rpcError: { code: 'workspace/session-active', details: { activity: error.activity } },
        })
      }
    },
    async unarchiveSession(threadId) {
      const { thread, workspacePaths } = await writeThreadAction({ threadId, action: 'unarchive' })
      catalog.acceptThread({ ...thread, archived: false }, workspacePaths)
    },
    pinSession: threadId => writeThreadAction({ threadId, action: 'pin', pinned: true }),
    unpinSession: threadId => writeThreadAction({ threadId, action: 'pin', pinned: false }),
  }

  ctx.provide('sessions', sessions)
  ctx.provide('workspaces', workspaces)
  ctx.provide('fileUpload', { upload: rejectWrite })
  ctx.effect(() => catalog.store.subscribe(syncSessions))
  ctx.inject(['uiWorkspace'], scope => {
    scope.effect(() => {
      const navigation = scope.uiWorkspace
      const startSession = navigation.startSession
      // RC2 的无参数入口会强制新建。传入原生默认草稿选项，让 DSH 沿用工作区的空白会话。
      const startWithDraft = (workspaceId, options = {}) => startSession.call(navigation, workspaceId, options)
      navigation.startSession = startWithDraft
      function reconcile() {
        const { busy, error, selected, threads, childThreads } = catalog.store.getSnapshot()
        if (initialization === 'ready' && selected && !childThreads[selected.id]
          && !threads.some(thread => thread.id === selected.id)) {
          const next = threads.find(thread => !thread.archived)
          if (next) scope.uiWorkspace.openSession(next.id)
          else scope.uiWorkspace.clearMain()
          return
        }
        if (initialization !== 'waiting' || busy || error) return
        // DSH 自己保存上次选中的会话，包括只留草稿的空白会话。
        initialization = 'opening'
        const saved = navigation.selection?.getSnapshot()?.sessionId
        const thread = selected ?? threads.find(thread => thread.id === saved)
          ?? threads.find(thread => !thread.archived && !thread.blank) ?? threads[0]
        if (thread) scope.uiWorkspace.openSession(thread.id)
        initialization = 'ready'
        syncSessions()
      }
      reconcile()
      const stop = catalog.store.subscribe(reconcile)
      return () => {
        stop()
        if (navigation.startSession === startWithDraft) navigation.startSession = startSession
      }
    })
  })

  return async threadId => {
    await writeThreadAction({ threadId, action: 'delete' })
    catalog.removeThread(threadId)
  }
}
