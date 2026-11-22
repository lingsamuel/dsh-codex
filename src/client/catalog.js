import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages } from '../shared/pages.js'
import { readPage } from './api.js'

/** 会话状态由侧栏和主区共享，原生数据仅留在页面内存。 */
export function createHistoryCatalog(signal) {
  const store = createSnapshotStore({
    projects: [],
    threads: [],
    unreadIds: [],
    workspacePaths: {},
    selected: null,
    busy: true,
    error: '',
  })
  let refreshing = false
  const observedStatuses = new Map()
  const observedReadStates = new Map()
  const searchThreads = new Map()
  const searchPaths = {}
  let followsLocalReceipts = false

  function publish({ projects, threads, workspacePaths }) {
    store.update(state => {
      state.projects = projects
      state.threads = mergePages(threads, searchThreads.values()).map(thread => observedStatuses.has(thread.id)
        ? { ...thread, status: observedStatuses.get(thread.id) }
        : thread)
      if (!followsLocalReceipts) {
        state.unreadIds = threads.filter(({ id, readState }) =>
          (observedReadStates.get(id) ?? readState?.firstUnread != null)).map(thread => thread.id)
      }
      state.workspacePaths = { ...searchPaths, ...workspacePaths }
      state.selected = state.threads.find(thread => thread.id === state.selected?.id) ?? state.selected
      state.busy = false
      state.error = ''
    })
  }

  async function refresh() {
    if (refreshing || signal.aborted) return
    refreshing = true
    try {
      // 快速索引先填充导航，较慢的旧历史扫描完成后自动补齐。
      const index = await readPage('catalog', {}, signal)
      publish(index)
      if (!index.complete) publish(await readPage('catalog', { complete: 1 }, signal))
    } catch (error) {
      if (!signal.aborted) store.update(state => { state.error = error.message })
    } finally {
      refreshing = false
      if (!signal.aborted) store.update(state => { state.busy = false })
    }
  }

  void refresh()
  window.addEventListener('focus', refresh, { signal })

  return {
    store,
    async search(searchTerm, searchSignal) {
      const requestSignal = AbortSignal.any([signal, searchSignal])
      const { data, nextCursor, workspacePaths } = await readPage('search', { searchTerm }, requestSignal)
      requestSignal.throwIfAborted()
      store.update(state => {
        // DSH 只显示已知会话的搜索结果。快速清单补齐期间保留搜索新发现的线程。
        const known = new Set(state.threads.map(thread => thread.id))
        const found = data.map(result => result.thread).filter(thread => !known.has(thread.id))
        for (const thread of found) searchThreads.set(thread.id, thread)
        Object.assign(searchPaths, workspacePaths)
        state.threads = mergePages(state.threads, found)
        state.workspacePaths = { ...searchPaths, ...state.workspacePaths }
      })
      return { items: data.map(({ thread, snippet }) => ({ sessionId: thread.id, snippet })), hasMore: Boolean(nextCursor) }
    },
    setStatus(threadId, status) {
      observedStatuses.set(threadId, status)
      store.update(state => {
        const thread = state.threads.find(item => item.id === threadId)
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
}
