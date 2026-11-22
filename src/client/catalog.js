import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages } from '../shared/pages.js'
import { readPage, writeProjectAction, writeThreadAction } from './api.js'
import { openLiveWatch } from './live-watch.js'
import { subagentAddress } from './native-dsh/subagents.js'
import { searchCodexThreads } from './thread-search.js'

function applyChanges(entries, changes) {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  for (const [id, entry] of changes) {
    if (entry) {
      // 项目归属或改名通知可能先于归档清单。只有显式归档状态才覆盖清单里的状态。
      const archived = byId.get(id)?.archived
      byId.set(id, entry.archived === undefined && archived !== undefined ? { ...entry, archived } : entry)
    }
    else byId.delete(id)
  }
  return [...byId.values()]
}

function mergeArchiveCatalog(threads, archived) {
  const ids = new Set(archived.map(thread => thread.id))
  return mergePages(threads.filter(thread => !thread.archived && !ids.has(thread.id)), archived)
}

function withThreadStatus(thread, status, blank = thread.blank) {
  return { ...thread, status, ...(blank !== undefined && {
    blank: Boolean(blank && status?.type === 'idle' && !thread.name && !thread.preview),
  }) }
}

function threadCreatedAt(thread) {
  // Codex 会话 ID 保留毫秒级创建时间，摘要中的时间只有秒级精度。
  const uuidTime = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(thread.id)
  return uuidTime ? Number.parseInt(uuidTime[1] + uuidTime[2], 16) : thread.createdAt * 1000
}

/** 会话状态由侧栏和主区共享，原生数据仅留在页面内存。 */
export function createHistoryCatalog(signal) {
  const openedAt = Date.now()
  const emptyTerminals = new Map()
  const backgroundTerminals = createSnapshotStore(emptyTerminals)
  const store = createSnapshotStore({
    projects: [],
    threads: [],
    newThreadIds: [],
    childThreads: {},
    childCatalogs: {},
    unreadIds: [],
    readStates: {},
    workspacePaths: {},
    selected: null,
    readVisit: 0,
    manualUnreadVisit: 0,
    busy: true,
    error: '',
  })
  let refreshing = false
  let pendingRefresh = false
  let connected = false
  let verified = false
  let completeReadStarted = false
  let liveProjects
  let archivedThreads = []
  let nextReadVisit = 0
  const observedThreads = new Map()
  const observedStatuses = new Map()
  const observedReadStates = new Map()
  const searchThreads = new Map()
  const threadChanges = new Map()
  const childReads = new Map()
  const childChanges = new Map()
  const changedPaths = {}
  let followsLocalReceipts = false

  function recordNewThreads(state, threads, confirmedCreation = false) {
    const additions = []
    for (const thread of threads) {
      if (thread.blank || thread.ephemeral || subagentAddress(thread)) continue
      const observed = observedThreads.get(thread.id)
      if (observed === true || (observed === false && !confirmedCreation)) continue
      // 旧历史可能刚更新或刚补齐，用创建时间区分会话新建和目录发现。
      const createdAt = threadCreatedAt(thread)
      if (!confirmedCreation && !Number.isFinite(createdAt)) continue
      const created = !thread.archived && (confirmedCreation || createdAt >= openedAt)
      observedThreads.set(thread.id, created)
      if (created) additions.push({ id: thread.id, createdAt })
    }
    additions.sort((a, b) => a.createdAt - b.createdAt)
    for (const thread of additions) state.newThreadIds.push(thread.id)
  }

  function publish({ projects, threads, workspacePaths }) {
    store.update(state => {
      state.projects = liveProjects ?? projects
      const merged = applyChanges(mergePages(mergeArchiveCatalog(threads, archivedThreads), searchThreads.values()), threadChanges)
      state.threads = merged.map(thread => observedStatuses.has(thread.id)
        ? withThreadStatus(thread, observedStatuses.get(thread.id))
        : thread)
      recordNewThreads(state, merged)
      state.readStates = Object.fromEntries(state.threads.flatMap(({ id, readState }) => {
        const receipt = observedReadStates.get(id) ?? readState
        return receipt ? [[id, receipt]] : []
      }))
      if (!followsLocalReceipts) {
        state.unreadIds = Object.keys(state.readStates).filter(id => state.readStates[id].firstUnread != null)
      }
      state.workspacePaths = { ...workspacePaths, ...changedPaths }
      state.selected = state.threads.find(thread => thread.id === state.selected?.id) ?? state.selected
      state.busy = false
      state.error = ''
    })
  }

  async function refreshCompleteCatalog() {
    const earlier = new Map(threadChanges)
    completeReadStarted = true
    const snapshot = await readPage('catalog', { complete: 1, fresh: 1 }, signal)
    // 原生快照涵盖读取前的增量。从此保留新的事件，避免旧启动事件盖住已保存的预览。
    for (const thread of snapshot.threads) {
      const previous = earlier.get(thread.id)
      if (previous && threadChanges.get(thread.id) === previous) threadChanges.delete(thread.id)
    }
    publish(snapshot)
  }

  async function loadArchived() {
    try {
      const { threads, workspacePaths } = await readPage('archived', {}, signal)
      signal.throwIfAborted()
      archivedThreads = threads
      Object.assign(changedPaths, workspacePaths)
      store.update(state => {
        state.threads = applyChanges(mergeArchiveCatalog(state.threads, threads), threadChanges)
        recordNewThreads(state, threads)
        for (const { id, readState } of threads) {
          if (readState && !state.readStates[id]) state.readStates[id] = readState
        }
        Object.assign(state.workspacePaths, workspacePaths)
      })
    } catch {
      // 归档暂不可用时保留已加载的清单和普通会话。
    }
  }

  function setReadState(threadId, readState) {
    if (!readState || observedReadStates.get(threadId)?.revision === readState.revision) return
    observedReadStates.set(threadId, readState)
    store.update(state => {
      state.readStates[threadId] = readState
      const unread = readState.firstUnread != null
      if (unread && !state.unreadIds.includes(threadId)) state.unreadIds.push(threadId)
      if (!unread) state.unreadIds = state.unreadIds.filter(id => id !== threadId)
    })
  }

  function loadChildren(parentId, force = false) {
    if (childReads.has(parentId)) return childReads.get(parentId)
    if (!force && store.getSnapshot().childCatalogs[parentId]?.state === 'idle') return Promise.resolve()
    store.update(state => {
      state.childCatalogs[parentId] = { state: 'loading', ids: state.childCatalogs[parentId]?.ids ?? [] }
    })
    const snapshot = store.getSnapshot()
    const parent = snapshot.childThreads[parentId] ?? snapshot.threads.find(thread => thread.id === parentId)
    const read = readPage('children', { threadId: parentId, ...(parent?.archived && { archived: 1 }) }, signal).then(entries => {
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

  /** 活动可能引用其他分支的子线程。按原生 ID 补齐未展开的父级，供面包屑使用。 */
  async function resolveSubagent(threadId, viewSignal) {
    const requestSignal = AbortSignal.any([signal, viewSignal])
    const missing = new Map()
    let id = threadId
    while (id && !missing.has(id)) {
      const { childThreads, threads } = store.getSnapshot()
      if (childThreads[id] || threads.some(thread => thread.id === id)) break
      const { thread } = await readPage('thread-summary', { threadId: id }, requestSignal)
      const address = subagentAddress(thread)
      if (!address) break
      missing.set(id, thread)
      id = address.parentSessionId
    }
    requestSignal.throwIfAborted()
    if (missing.size) {
      store.update(state => {
        for (const [id, thread] of missing) {
          // 读取期间目录可能已收到更新或删除，优先使用原生广播。
          if (threadChanges.get(id) === null) continue
          const current = childChanges.has(id) ? childChanges.get(id) : thread
          if (current) state.childThreads[id] ??= withThreadStatus(current, observedStatuses.get(id) ?? current.status)
        }
      })
    }
    return subagentAddress(store.getSnapshot().childThreads[threadId])
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
        for (const changes of [threadChanges, childChanges, observedStatuses, observedReadStates]) changes.clear()
        liveProjects = undefined
        searchThreads.clear()
        await refreshCompleteCatalog()
        verified = true
        await loadArchived()
        for (const parentId of Object.keys(store.getSnapshot().childCatalogs)) {
          await childReads.get(parentId)
          await loadChildren(parentId, true)
        }
        return
      }
      // 快速索引先填充导航，较慢的旧历史扫描完成后自动补齐。
      const index = await readPage('catalog', verified ? {} : { fresh: 1 }, signal)
      publish(index)
      // 缓存可先绘制一屏，新页面随后对照原生清单校验一次。
      if (!index.complete || !verified) {
        if (verified) publish(await readPage('catalog', { complete: 1 }, signal))
        else await refreshCompleteCatalog()
        verified = true
      }
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
    backgroundTerminals,
    loadChildren,
    resolveSubagent,
    setReadState,
    acceptThread(thread, workspacePaths, confirmedCreation = false) {
      receive({ type: 'thread', id: thread.id, thread, workspacePaths, confirmedCreation })
    },
    acceptProject(project, workspacePaths) {
      const projects = mergePages(store.getSnapshot().projects, [project])
      receive({ type: 'projects', projects, workspacePaths })
    },
    async updateProject(action) {
      const previous = store.getSnapshot().projects
      const { projectId, moved = [], failed = [], ...snapshot } = await writeProjectAction(action, signal)
      // 广播可能已应用更近的原生列表。操作回读只补齐尚未观察到的更新。
      if (store.getSnapshot().projects === previous) receive({ type: 'projects', ...snapshot })
      if (moved.length) {
        const ids = new Set(moved)
        store.update(state => {
          state.threads = state.threads.map(thread => {
            if (!ids.has(thread.id) || thread.projectId) return thread
            // 只应用项目归属，保留同时收到的归档、状态和标题等其他更新。
            const current = { ...thread, projectId }
            threadChanges.set(thread.id, current)
            if (state.selected?.id === thread.id) state.selected = current
            return current
          })
        })
      }
      return { moved, failed }
    },
    removeThread(id) {
      receive({ type: 'thread', id, thread: null })
    },
    seedReadState(threadId, readState) {
      if (!store.getSnapshot().readStates[threadId]) setReadState(threadId, readState)
    },
    async writeReadState(threadId, action, expectedRevision) {
      const start = store.getSnapshot().readStates[threadId]?.revision
      if (action === 'unread' && store.getSnapshot().selected?.id === threadId) {
        store.update(state => { state.manualUnreadVisit = state.readVisit })
      }
      function accept(receipt) {
        // 响应可能比另一客户端的广播晚到。已有新版本时沿用原生事件顺序。
        if (store.getSnapshot().readStates[threadId]?.revision === start) setReadState(threadId, receipt)
      }
      try {
        const { readState } = await writeThreadAction({ threadId, action, expectedRevision }, signal)
        accept(readState)
      } catch (error) {
        if (error.status === 409) accept(error.readState)
        throw error
      }
    },
    async search(searchTerm, searchSignal, archiveFilter) {
      const requestSignal = AbortSignal.any([signal, searchSignal])
      const { data, hasMore, workspacePaths } = await searchCodexThreads(searchTerm, requestSignal, archiveFilter)
      requestSignal.throwIfAborted()
      store.update(state => {
        // DSH 只显示已知会话的搜索结果。快速清单补齐期间保留搜索新发现的线程。
        const known = new Set(state.threads.map(thread => thread.id))
        const found = data.map(result => result.thread).filter(thread => !known.has(thread.id) && !threadChanges.has(thread.id))
        for (const thread of found) searchThreads.set(thread.id, thread)
        Object.assign(changedPaths, workspacePaths)
        state.threads = mergePages(state.threads, found)
        recordNewThreads(state, found)
        state.workspacePaths = { ...state.workspacePaths, ...workspacePaths }
      })
      return { items: data.map(({ thread, snippet }) => ({ sessionId: thread.id, snippet })), hasMore }
    },
    setStatus(threadId, status) {
      observedStatuses.set(threadId, status)
      const { childThreads, threads } = store.getSnapshot()
      const child = childThreads[threadId]
      const index = child ? -1 : threads.findIndex(thread => thread.id === threadId)
      const thread = child ?? threads[index]
      if (!thread) return
      const updated = withThreadStatus(thread, status)
      // 首次执行后，尚未重新读取的清单或启动增量也不能把该会话恢复成可复用草稿。
      if (thread.blank && !updated.blank) threadChanges.set(threadId, updated)
      store.update(state => {
        if (child) state.childThreads[threadId] = updated
        else {
          state.threads[index] = updated
          if (thread.blank && status?.type === 'active') recordNewThreads(state, [updated])
        }
        if (state.selected?.id === threadId) state.selected = updated
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
    select(thread, explicit = false) {
      store.update(state => {
        state.selected = thread
        state.readVisit = thread && explicit ? ++nextReadVisit : 0
      })
    },
  }

  function receive(frame) {
    if (frame.type === 'catalog-ready') {
      // 完整清单可能先于首次订阅开始读取，需要补上两者之间的新增。
      const catchUp = connected || completeReadStarted
      connected = true
      if (catchUp) void refresh(true)
    } else if (frame.type === 'background-terminals') {
      backgroundTerminals.set(new Map(Object.entries(frame.byThread)))
    } else if (frame.type === 'unread') catalog.applyUnread(frame)
    else if (frame.type === 'notification') {
      const { method, params } = frame.notification
      if (method === 'thread/status/changed') {
        catalog.setStatus(params.threadId, params.status)
        if (frame.thread) receive({ ...frame, type: 'thread', id: params.threadId })
      }
      if (method === 'thread/readState/changed') catalog.setReadState(params.threadId, params.readState)
    } else if (frame.type === 'thread') {
      const { id, thread, readState, workspacePaths, confirmedCreation } = frame
      const { childThreads, threads } = store.getSnapshot()
      const previous = childThreads[id] ?? threads.find(thread => thread.id === id)
      const status = observedStatuses.get(id) ?? thread?.status ?? previous?.status
      // 仅归档清单和显式归档事件提供这个字段。普通摘要更新应保留已有状态。
      const archived = thread?.archived ?? previous?.archived
      // 原生启动广播不带空白标记，可能先于或晚于创建响应。
      const current = thread && withThreadStatus({ ...thread, ...(archived !== undefined && { archived }) }, status, thread.blank ?? previous?.blank)
      const parent = subagentAddress(thread ?? previous)?.parentSessionId
      if (parent) {
        childChanges.set(id, current)
        store.update(state => {
          const branch = state.childCatalogs[parent]
          if (!branch && !state.childThreads[id]) return
          if (current) {
            state.childThreads[id] = current
            if (branch && !branch.ids.includes(id)) branch.ids.push(id)
          } else {
            delete state.childThreads[id]
            if (branch) branch.ids = branch.ids.filter(childId => childId !== id)
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
        if (current && !thread.blank) recordNewThreads(state, [current], confirmedCreation)
        Object.assign(state.workspacePaths, workspacePaths)
        if (current && state.selected?.id === id) state.selected = current
        if (!current) delete state.readStates[id]
      })
      if (readState !== undefined) catalog.setReadState(id, readState)
    } else if (frame.type === 'projects') {
      const { projects, workspacePaths } = frame
      liveProjects = projects
      Object.assign(changedPaths, workspacePaths)
      store.update(state => {
        state.projects = projects
        Object.assign(state.workspacePaths, workspacePaths)
      })
    }
  }

  openLiveWatch(null, {
    receive,
    changeMode: () => backgroundTerminals.set(emptyTerminals),
    backgroundTerminals: true,
  }, signal)
  void refresh()
  void loadArchived()
  window.addEventListener('focus', () => { void refresh() }, { signal })
  return catalog
}
