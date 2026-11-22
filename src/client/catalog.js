import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { readPage } from './api.js'

/** 会话状态由侧栏和主区共享，原生数据仅留在页面内存。 */
export function createHistoryCatalog(signal) {
  const store = createSnapshotStore({
    projects: [],
    threads: [],
    workspacePaths: {},
    selected: null,
    busy: true,
    error: '',
  })
  let refreshing = false

  function publish({ projects, threads, workspacePaths }) {
    store.update(state => {
      state.projects = projects
      state.threads = threads
      state.workspacePaths = workspacePaths
      state.selected = threads.find(thread => thread.id === state.selected?.id) ?? state.selected
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
    select(thread) {
      store.update(state => { state.selected = thread })
    },
  }
}
