import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages, readPage } from './api.js'

/** 会话状态由侧栏和主区共享，原生数据仅留在页面内存。 */
export function createHistoryCatalog(signal) {
  const store = createSnapshotStore({ projects: [], threads: [], selected: null, nextCursor: null, busy: true, error: '' })

  async function loadProjects() {
    let cursor
    do {
      const page = await readPage('projects', cursor ? { cursor } : {}, signal)
      store.update(state => { state.projects = mergePages(state.projects, page.data) })
      cursor = page.nextCursor
    } while (cursor)
  }

  async function loadThreads(cursor) {
    store.update(state => {
      state.busy = true
      state.error = ''
    })
    try {
      const page = await readPage('threads', cursor ? { cursor } : {}, signal)
      store.update(state => {
        state.threads = mergePages(cursor ? state.threads : [], page.data)
        state.nextCursor = page.nextCursor
      })
    } catch (error) {
      if (!signal.aborted) store.update(state => { state.error = error.message })
    } finally {
      if (!signal.aborted) store.update(state => { state.busy = false })
    }
  }

  void loadThreads()
  void loadProjects().catch(error => {
    if (!signal.aborted) store.update(state => { state.error = error.message })
  })

  return {
    store,
    loadMore() {
      const { nextCursor, busy } = store.getSnapshot()
      if (!busy && nextCursor) void loadThreads(nextCursor)
    },
    select(thread) {
      store.update(state => { state.selected = thread })
    },
  }
}
