import { mergePages } from '../shared/pages.js'
import { CodexRpcError, findCodexSocket, readCodexPages, withCodexReader } from './app-server.mjs'
import { catalogCachePath, readCatalogCache, saveCatalogCache } from './catalog-cache.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'

export async function readProjectPage(request, params) {
  try {
    return await request('project/list', params)
  } catch (error) {
    if (error instanceof CodexRpcError && error.code === -32601) {
      return { data: [], nextCursor: null }
    }
    throw error
  }
}

async function collectPages(read) {
  const entries = await readCodexPages(cursor => read({ limit: 100, ...(cursor != null && { cursor }) }))
  return mergePages([], entries)
}

async function loadCatalog(socketPath, signal, complete) {
  const { projects, threads } = await withCodexReader(socketPath, signal, async request => {
    const projects = await collectPages(params => readProjectPage(request, params))
    const threads = await collectPages(async params => {
      const page = await request('thread/list', {
        ...params,
        modelProviders: [],
        sortKey: 'updated_at',
        useStateDbOnly: !complete,
      })
      if (!page.readStates) return page
      return { ...page, data: page.data.map(thread => {
        const readState = page.readStates[thread.id]
        return readState ? { ...thread, readState } : thread
      }) }
    })
    return { projects, threads }
  }, complete ? 90_000 : 15_000)

  const paths = [
    ...projects.flatMap(project => project.roots.map(root => root.path)),
    ...threads.map(thread => thread.cwd),
  ]
  const workspacePaths = await resolveWorkspacePaths(paths)
  signal?.throwIfAborted()
  return { projects, threads, workspacePaths, complete }
}

/** 缓存同一进程使用的原生列表快照，完整扫描只在需要时补齐旧历史。 */
export function createCatalogReader(socketPath, signal, cacheDirectory) {
  let snapshot
  let refreshedAt = null
  let source
  const pending = new Map()

  async function openSource() {
    if (!cacheDirectory) return { endpoint: socketPath }
    const timeout = AbortSignal.timeout(15_000)
    const discoverySignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const endpoint = socketPath || await findCodexSocket(discoverySignal)
    const cachePath = catalogCachePath(cacheDirectory, endpoint)
    const cached = await readCatalogCache(cachePath)
    discoverySignal.throwIfAborted()
    if (cached) snapshot = cached
    return { endpoint, cachePath }
  }

  return async function readCatalog(complete, freshRequired = false) {
    source ??= openSource().catch(error => {
      source = undefined
      throw error
    })
    const { endpoint, cachePath } = await source
    const fresh = refreshedAt !== null && Date.now() - refreshedAt < 60_000
    if (!freshRequired && snapshot && fresh && (!complete || snapshot.complete)) {
      return snapshot
    }
    // 完整快照过期后仍可显示，只有成功完成刷新才更新目录和会话。
    if (!complete && snapshot?.complete) return { ...snapshot, complete: false }
    if (pending.has(complete)) return pending.get(complete)

    const previous = snapshot
    const refresh = loadCatalog(endpoint, signal, complete).then(async result => {
      // 较晚完成的快速索引不能覆盖刚到达的完整清单。
      if (complete || snapshot === previous) {
        snapshot = result
        refreshedAt = Date.now()
      }
      if (complete && cachePath) await saveCatalogCache(cachePath, result, signal)
      return snapshot
    }).catch(error => {
      if (complete || signal?.aborted) throw error
      return readCatalog(true)
    }).finally(() => pending.delete(complete))
    pending.set(complete, refresh)
    return refresh
  }
}
