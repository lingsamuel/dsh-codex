import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages } from '../shared/pages.js'
import { readPage } from './api.js'
import { openLiveWatch } from './live-watch.js'
import { subagentAddress } from './native-dsh/subagents.js'

function applyChanges(entries, changes) {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  for (const [id, entry] of changes) {
    if (entry) byId.set(id, entry)
    else byId.delete(id)
  }
  return [...byId.values()]
}

/** 会话状态由侧栏和主区共享，原生数据仅留在页面内存。 */
export function createHistoryCatalog(signal) {
  const store = createSnapshotStore({
    projects: [],
    threads: [],
    childThreads: {},
    childCatalogs: {},
    unreadIds: [],
    workspacePaths: {},
    selected: null,
    busy: true,
    error: '',
  })
  let refreshing = false
  let pendingRefresh = false
  let connected = false
  let archivedThreads = []
  const observedStatuses = new Map()
  const observedReadStates = new Map()
  const searchThreads = new Map()
  const threadChanges = new Map()
  const projectChanges = new Map()
  const childReads = new Map()
  const childChanges = new Map()
  const changedPaths = {}
  let followsLocalReceipts = false

  function publish({ projects, threads, workspacePaths }) {
    store.update(state => {
      state.projects = applyChanges(projects, projectChanges).sort((a, b) => a.position - b.position)
      state.threads = applyChanges(mergePages(threads, [...archivedThreads, ...searchThreads.values()]), threadChanges).map(thread => observedStatuses.has(thread.id)
        ? { ...thread, status: observedStatuses.get(thread.id) }
        : thread)
      if (!followsLocalReceipts) {
        state.unreadIds = state.threads.filter(({ id, readState }) =>
          (observedReadStates.get(id) ?? (readState?.firstUnread != null))).map(thread => thread.id)
      }
      state.workspacePaths = { ...workspacePaths, ...changedPaths }
      state.selected = state.threads.find(thread => thread.id === state.selected?.id) ?? state.selected
      state.busy = false
      state.error = ''
    })
  }

  async function loadArchived() {
    try {
      const { threads, workspacePaths } = await readPage('archived', {}, signal)
      signal.throwIfAborted()
      archivedThreads = threads
      Object.assign(changedPaths, workspacePaths)
      store.update(state => {
        state.threads = applyChanges(mergePages(state.threads.filter(thread => !thread.archived), threads), threadChanges)
        Object.assign(state.workspacePaths, workspacePaths)
      })
    } catch {
      // 归档暂不可用时保留已加载的清单和普通会话。
    }
  }

  function loadChildren(parentId, force = false) {
    if (childReads.has(parentId)) return childReads.get(parentId)
    if (!force && store.getSnapshot().childCatalogs[parentId]?.state === 'idle') return Promise.resolve()
    store.update(state => {
      state.childCatalogs[parentId] = { state: 'loading', ids: state.childCatalogs[parentId]?.ids ?? [] }
    })
    const read = readPage('children', { threadId: parentId }, signal).then(entries => {
      signal.throwIfAborted()
      store.update(state => {
        const matching = [...childChanges].filter(([id, thread]) =>
          subagentAddress(thread)?.parentSessionId === parentId || (!thread && entries.some(child => child.id === id)))
        const children = applyChanges(entries, matching)
        for (const thread of children) state.childThreads[thread.id] = {
          ...thread, status: observedStatuses.get(thread.id) ?? thread.status,
          parentThreadId: parentId,
        }
        state.childCatalogs[parentId] = { state: 'idle', ids: children.map(thread => thread.id) }
      })
    }).catch(error => {
      if (signal.aborted) return
      store.update(state => {
        state.childCatalogs[parentId].state = 'error'
        state.childCatalogs[parentId].error = { code: 'codex/history', message: error.message }
      })
    }).finally(() => childReads.delete(parentId))
    childReads.set(parentId, read)
    return read
  }

  async function refresh(fresh = false) {
    if (signal.aborted) return
    if (refreshing) {
      pendingRefresh ||= fresh
      return
    }
    refreshing = true
    try {
      if (fresh) {
        // 重连只补一次断线间隔，期间到达的增量仍覆盖读取中的快照。
        for (const changes of [threadChanges, projectChanges, observedStatuses, observedReadStates]) changes.clear()
        searchThreads.clear()
        publish(await readPage('catalog', { complete: 1, fresh: 1 }, signal))
        await loadArchived()
        const selected = store.getSnapshot().selected
        if (selected) void loadChildren(selected.id, true)
        return
      }
      // 快速索引先填充导航，较慢的旧历史扫描完成后自动补齐。
      const index = await readPage('catalog', {}, signal)
      publish(index)
      if (!index.complete) publish(await readPage('catalog', { complete: 1 }, signal))
    } catch (error) {
      if (!signal.aborted) store.update(state => { state.error = error.message })
    } finally {
      refreshing = false
      if (!signal.aborted) store.update(state => { state.busy = false })
      if (pendingRefresh) {
        pendingRefresh = false
        void refresh(true)
      }
    }
  }

  const catalog = {
    store,
    loadChildren,
    async search(searchTerm, searchSignal) {
      const requestSignal = AbortSignal.any([signal, searchSignal])
      const { data, nextCursor, workspacePaths } = await readPage('search', { searchTerm }, requestSignal)
      requestSignal.throwIfAborted()
      store.update(state => {
        // DSH 只显示已知会话的搜索结果。快速清单补齐期间保留搜索新发现的线程。
        const known = new Set(state.threads.map(thread => thread.id))
        const found = data.map(result => result.thread).filter(thread => !known.has(thread.id) && !threadChanges.has(thread.id))
        for (const thread of found) searchThreads.set(thread.id, thread)
        Object.assign(changedPaths, workspacePaths)
        state.threads = mergePages(state.threads, found)
        state.workspacePaths = { ...state.workspacePaths, ...workspacePaths }
      })
      return { items: data.map(({ thread, snippet }) => ({ sessionId: thread.id, snippet })), hasMore: Boolean(nextCursor) }
    },
    setStatus(threadId, status) {
      observedStatuses.set(threadId, status)
      store.update(state => {
        const thread = state.childThreads[threadId] ?? state.threads.find(item => item.id === threadId)
        if (thread) thread.status = status
      })
    },
    setReadState(threadId, readState) {
      if (followsLocalReceipts) return
      const unread = readState?.firstUnread != null
      observedReadStates.set(threadId, unread)
      store.update(state => {
        if (unread && !state.unreadIds.includes(threadId)) state.unreadIds.push(threadId)
        if (!unread) state.unreadIds = state.unreadIds.filter(id => id !== threadId)
      })
    },
    applyUnread({ replace, added, removed }) {
      followsLocalReceipts = true
      store.update(state => {
        const ids = new Set(replace ? [] : state.unreadIds)
        for (const id of removed) ids.delete(id)
        for (const id of added) ids.add(id)
        state.unreadIds = [...ids]
      })
    },
    select(thread) {
      store.update(state => { state.selected = thread })
    },
  }

  function receive(frame) {
    if (frame.type === 'catalog-ready') {
      if (connected) void refresh(true)
      connected = true
    } else if (frame.type === 'unread') catalog.applyUnread(frame)
    else if (frame.type === 'notification') {
      const { method, params } = frame.notification
      if (method === 'thread/status/changed') catalog.setStatus(params.threadId, params.status)
      if (method === 'thread/readState/changed') catalog.setReadState(params.threadId, params.readState)
    } else if (frame.type === 'thread') {
      const { id, thread, readState, workspacePaths } = frame
      const status = observedStatuses.get(id) ?? thread?.status
      const current = thread && { ...thread, status }
      const parent = subagentAddress(thread ?? store.getSnapshot().childThreads[id])?.parentSessionId
      if (parent) {
        childChanges.set(id, current)
        store.update(state => {
          const branch = state.childCatalogs[parent]
          if (!branch) return
          if (current) {
            state.childThreads[id] = current
            if (!branch.ids.includes(id)) branch.ids.push(id)
          } else {
            delete state.childThreads[id]
            branch.ids = branch.ids.filter(childId => childId !== id)
          }
        })
        return
      }
      if (thread?.ephemeral) return
      threadChanges.set(id, current)
      if (!current) {
        searchThreads.delete(id)
        observedStatuses.delete(id)
        observedReadStates.delete(id)
      }
      Object.assign(changedPaths, workspacePaths)
      store.update(state => {
        state.threads = applyChanges(state.threads, [[id, current]]).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        Object.assign(state.workspacePaths, workspacePaths)
        if (current && state.selected?.id === id) state.selected = current
      })
      if (readState !== undefined) catalog.setReadState(id, readState)
    } else if (frame.type === 'project') {
      const { id, project, workspacePaths } = frame
      projectChanges.set(id, project)
      Object.assign(changedPaths, workspacePaths)
      store.update(state => {
        state.projects = applyChanges(state.projects, [[id, project]]).sort((a, b) => a.position - b.position)
        Object.assign(state.workspacePaths, workspacePaths)
      })
    }
  }

  openLiveWatch(null, { receive }, signal)
  void refresh()
  void loadArchived()
  window.addEventListener('focus', () => { void refresh() }, { signal })
  return catalog
}
