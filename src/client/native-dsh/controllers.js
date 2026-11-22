import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { observe, projectCatalog, remoteFailure } from './catalog.js'
import { createCodexHistory } from './session-events.js'
import { createSessionInput } from './session-input.js'
import { subagentAddress } from './subagents.js'
import { writeConversationAction, writeThreadAction } from '../api.js'
import { workspaceProjectId } from '../workspaces.js'
import { searchResultLimit } from '../thread-search.js'

const flatSessionOrderKey = '__flat_session_order__'
const workspaceSlot = 'sidebar.workspaces'

// 切换会话会释放历史绑定。输入设置与原生文本草稿一样在返回后可继续使用。
function sessionDraft(storage, threadId) {
  const draft = observe(storage, drafts => drafts.get(threadId))
  function setDraft(selection) {
    const drafts = new Map(storage.getSnapshot())
    if (selection) drafts.set(threadId, selection)
    else drafts.delete(threadId)
    storage.set(drafts)
  }
  return { ...draft, set: setDraft, clear(selection) {
    if (selection && draft.getSnapshot() === selection) setDraft(undefined)
  } }
}

function changeRetainCount(counts, key, delta) {
  const count = (counts[key] ?? 0) + delta
  if (count > 0) counts[key] = count
  else delete counts[key]
}

function codexBinding(ctx, thread, catalog, modelDrafts, permissionDrafts, worktreeDrafts, goalDrafts, retention, openWorktree) {
  const history = createCodexHistory(ctx, thread, catalog, retention)
  const modelDraft = sessionDraft(modelDrafts, thread.id)
  const permissionDraft = sessionDraft(permissionDrafts, thread.id)
  const worktreeDraft = sessionDraft(worktreeDrafts, thread.id)
  const goalDraft = sessionDraft(goalDrafts, thread.id)
  return {
    ctx,
    sessionId: thread.id,
    eventSource: history.events,
    ready: history.ready,
    session: {
      ...history.session,
      ...createSessionInput(ctx, thread.id, history, modelDraft, permissionDraft, worktreeDraft, openWorktree, goalDraft),
      goalDraft,
      worktreeDraft,
      openWorktree,
      modelDraft,
      permissionDraft,
      sessionId: thread.id,
      async rename(title, unarchive = false) {
        try {
          await writeThreadAction({ threadId: thread.id, action: 'rename', name: title, ...(unarchive && { unarchive: true }) })
          return { ok: true, value: { title } }
        } catch (error) {
          return { ok: false, error: remoteFailure(error.message) }
        }
      },
    },
  }
}

/** 为 DSH 提供 Codex 会话与工作区控制器。选择与保留引用都留在当前页面。 */
export function provideCodexControllers(ctx, catalog, withForkFeedback) {
  const projected = observe(catalog.store, projectCatalog)
  const list = createSnapshotStore({ ...projected.getSnapshot().sessions, phase: 'pending' })
  let initialization = 'waiting'
  let handledNewThreads = 0
  const bindings = new Map()
  const retention = new Map()
  const modelDrafts = createSnapshotStore(new Map())
  const permissionDrafts = createSnapshotStore(new Map())
  const worktreeDrafts = createSnapshotStore(new Map())
  const goalDrafts = createSnapshotStore(new Map())
  let navigation
  const scopeId = Symbol('Codex session')

  function syncManualOrder() {
    const { newThreadIds } = catalog.store.getSnapshot()
    if (handledNewThreads === newThreadIds.length) return
    const view = ctx.slots.entriesOfSlot(workspaceSlot)[0]?.store?.create()
    if (!view) return
    const arrivals = newThreadIds.slice(handledNewThreads)
    handledNewThreads = newThreadIds.length
    const viewState = view.getSnapshot()
    if (viewState.orderBy !== 'manual') return

    const { sessions, workspaces } = projected.getSnapshot()
    const orders = {}
    for (const id of arrivals) {
      if (!sessions.byId[id] || sessions.byId[id].blank || workspaces.archivedSessionIds.includes(id)) continue
      const workspace = workspaces.items.find(item => item.sessionIds.includes(id))
      for (const key of [workspace?.workspaceId ?? '', flatSessionOrderKey]) {
        const order = orders[key] ?? viewState.sessionOrderByAccount[key] ?? []
        if (!order.includes(id)) orders[key] = [id, ...order]
      }
    }
    // 复用侧栏保存顺序的操作，置顶分区继续由 DSH 生成。
    if (Object.keys(orders).length) view.actions.syncSessionOrders(orders)
  }

  function syncSessions() {
    syncManualOrder()
    const snapshot = projected.getSnapshot().sessions
    list.set(initialization === 'ready' ? snapshot : { ...snapshot, phase: 'pending' })
  }

  function retainInfo(id) {
    if (!retention.has(id)) {
      retention.set(id, createSnapshotStore({ referenceCount: 0, retainedBy: {}, retainedFacets: {} }))
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
    retain(target, { source, facets = {}, connection = source !== 'recentViews' }) {
      const id = typeof target === 'string' ? target : target.childSessionId
      const { threads, childThreads } = catalog.store.getSnapshot()
      const thread = childThreads[id] ?? threads.find(item => item.id === id)
      if (!thread) throw new Error(`找不到 Codex 会话 ${id}`)
      const observer = retainInfo(id)
      let record = bindings.get(id)
      if (!record) {
        const fiber = ctx.plugin(() => {})
        const openWorktree = ({ thread, workspacePaths, permission }, confirmed = true, handoff) => {
          const current = catalog.store.getSnapshot().threads.find(item => item.id === thread.id)
          if (confirmed || !current) {
            catalog.acceptThread(permission ? { ...thread, webPermission: permission } : thread, workspacePaths, confirmed)
          }
          // DSH 先完成输入栏的发送交接。若用户期间已打开其他会话，保留当前视图。
          setTimeout(() => {
            if (catalog.store.getSnapshot().selected?.id === id && navigation) {
              // 在主视图绑定之前接续气泡；实际打开会话时再启动历史连接。
              const reference = handoff && sessions.retain(thread.id, { source: 'submission', connection: false })
              try {
                handoff?.(reference.binding.session)
                navigation.openSession(thread.id)
              } finally {
                reference?.release()
              }
            } else handoff?.()
          }, 0)
        }
        record = { binding: codexBinding(fiber.ctx.extend({ [scopeId]: id }), thread, catalog,
          modelDrafts, permissionDrafts, worktreeDrafts, goalDrafts, observer, openWorktree), fiber }
        bindings.set(id, record)
        void catalog.loadChildren(id)
      }
      const { binding } = record
      const heldFacets = Object.keys(facets).filter(facet => facets[facet] === true)
      // 最近会话保留视图缓存。浏览器会把独立的 SSE 计入同源 HTTP/1.1 连接数。
      function shiftRetention(delta) {
        observer.update(state => {
          state.referenceCount += delta
          changeRetainCount(state.retainedBy, source, delta)
          for (const facet of heldFacets) changeRetainCount(state.retainedFacets, facet, delta)
          if (connection) changeRetainCount(state, 'connectionCount', delta)
        })
      }
      shiftRetention(1)
      if (source === 'mainView') catalog.select(thread, initialization !== 'opening')
      let released = false
      function release() {
        if (released) return
        released = true
        shiftRetention(-1)
        const info = observer.getSnapshot()
        if (source === 'mainView' && !info.retainedBy.mainView && catalog.store.getSnapshot().selected?.id === id) {
          catalog.select(null)
        }
        if (info.referenceCount === 0) {
          bindings.delete(id)
          void record.fiber.dispose()
        }
      }
      const ready = connection ? binding.ready.then(() => binding) : Promise.resolve(binding)
      return { sessionId: id, binding, ready, release, [Symbol.dispose]: release }
    },
    async create({ workspaceId, cwd, sessionId } = {}) {
      const workspace = workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      const directory = cwd ?? workspace?.path
      if (!directory) throw new Error('请先选择新会话的工作目录。')
      const projectId = workspaceProjectId(workspace?.workspaceId)
      const summaries = list.getSnapshot().byId
      const reuseThreadId = sessionId ?? workspace?.sessionIds.find(id => summaries[id]?.blank)
      const { thread, workspacePaths, permission } = await writeConversationAction({ action: 'create', cwd: directory, projectId, reuseThreadId })
      catalog.acceptThread(permission ? { ...thread, webPermission: permission } : thread, workspacePaths)
      return thread.id
    },
    async fork({ sessionId: threadId, atSeq, onCreated }) {
      const archived = workspaces.list.getSnapshot().archivedSessionIds.includes(threadId)
      const perform = async () => {
        const lastTurnId = atSeq === undefined ? undefined : sessions.binding(threadId)?.session.turnAtEnd(atSeq)
        if (atSeq !== undefined && !lastTurnId) throw new Error('找不到可分支的 Codex 轮次。')
        const { thread, workspacePaths } = await writeThreadAction({ threadId, action: 'fork', lastTurnId,
          ...(archived && { unarchive: true }) })
        // DSH 的回复分支会立即打开新会话，必须先让保留引用能从原生目录找到它。
        catalog.acceptThread(thread, workspacePaths, true)
        onCreated?.(thread.id)
        // 仅显示归档时侧栏会滤掉新分支，归档菜单分叉也直接打开结果。
        if (archived && atSeq === undefined) navigation?.openSession(thread.id)
        return thread.id
      }
      return withForkFeedback ? withForkFeedback(archived, perform) : perform()
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
    rename: (workspaceId, name) => catalog.updateProject({ action: 'rename', projectId: workspaceProjectId(workspaceId), name }),
    delete: workspaceId => catalog.updateProject({ action: 'delete', projectId: workspaceProjectId(workspaceId) }),
    insertBefore: (workspaceId, beforeWorkspaceId) => catalog.updateProject({ action: 'move',
      projectId: workspaceProjectId(workspaceId), beforeProjectId: workspaceProjectId(beforeWorkspaceId) }),
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
  ctx.effect(() => catalog.store.subscribe(syncSessions))
  ctx.effect(() => ctx.slots.subscribe(workspaceSlot, syncManualOrder))
  ctx.inject(['uiWorkspace'], scope => {
    scope.effect(() => {
      const currentNavigation = scope.uiWorkspace
      navigation = currentNavigation
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
        const saved = currentNavigation.selection?.getSnapshot()?.sessionId
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
        if (navigation === currentNavigation) navigation = undefined
      }
    })
  })

  return async threadId => {
    await writeThreadAction({ threadId, action: 'delete' })
    catalog.removeThread(threadId)
  }
}
