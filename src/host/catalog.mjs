import { mergePages } from '../shared/pages.js'
import { CodexRpcError, findCodexSocket, readCodexPages, withCodexReader } from './app-server.mjs'
import { catalogCachePath, readCatalogCache, saveCatalogCache } from './catalog-cache.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { subagentParentThreadId } from '../shared/codex-subagents.js'

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

/** 项目排序由 Codex 返回顺序决定，协议版本可以省略位置字段。 */
export function readProjects(request) {
  return collectPages(params => readProjectPage(request, params))
}

export async function readThreads(request, filters) {
  return collectPages(async params => {
    const page = await request('thread/list', {
      ...params, modelProviders: [], sortKey: 'updated_at', ...filters,
    })
    if (!page.readStates) return page
    return { ...page, data: page.data.map(thread => {
      const readState = page.readStates[thread.id]
      return readState ? { ...thread, readState } : thread
    }) }
  })
}

/** 归档历史单独补齐，避免拖慢常规目录的首屏。 */
export async function readArchivedCatalog(socketPath, signal) {
  const native = await withCodexReader(socketPath, signal, request => readThreads(request, { archived: true }), 90_000)
  const threads = native.map(thread => ({ ...thread, archived: true }))
  const workspacePaths = await resolveWorkspacePaths(threads.map(thread => thread.cwd))
  signal?.throwIfAborted()
  return { threads, workspacePaths }
}

/** 只查原生父线程的直接子代理，嵌套分支由调用方按需展开。 */
export async function readChildThreads(request, parentThreadId, archived = false) {
  const threads = await readThreads(request, {
    parentThreadId, sourceKinds: ['subAgent'], useStateDbOnly: true, ...(archived && { archived: true }),
  })
  return archived ? threads.map(thread => ({ ...thread, archived: true })) : threads
}

/** 精确读取子会话时以原生归档列表补齐 thread/read 未返回的归档标记。 */
export async function readThreadSummary(request, threadId) {
  const result = await request('thread/read', { threadId })
  const parentThreadId = subagentParentThreadId(result.thread)
  if (!parentThreadId) return result
  const archived = await readChildThreads(request, parentThreadId, true)
  return archived.some(thread => thread.id === threadId)
    ? { ...result, thread: { ...result.thread, archived: true } }
    : result
}

/** 为尚未发送消息的已加载线程标记草稿，供目录清单和实时事件共用。 */
export function withBlankDraft(thread) {
  const blank = thread.historyMode === 'paginated' && thread.status?.type === 'idle' && !thread.name && !thread.preview
  return blank ? { ...thread, blank: true } : thread
}

async function readUnlistedLoadedThreads(request, listed) {
  const ids = await readCodexPages(cursor => request('thread/loaded/list', { ...(cursor != null && { cursor }) }))
    .catch(error => {
      if (error instanceof CodexRpcError && error.code === -32601) return []
      throw error
    })
  const known = new Set(listed.map(thread => thread.id))
  const extra = await Promise.all(ids.filter(id => !known.has(id)).map(async threadId => {
    try {
      const { thread, readState } = await request('thread/read', { threadId })
      // 与普通原生清单保持相同的交互会话范围，无需恢复或订阅这些线程。
      if (thread.ephemeral || thread.archived || (thread.source !== 'cli' && thread.source !== 'vscode')) return null
      return withBlankDraft(readState ? { ...thread, readState } : thread)
    } catch (error) {
      // 会话可能在读取清单后被卸载，也可能正在保存首条记录。
      if (error instanceof CodexRpcError) return null
      throw error
    }
  }))
  return extra.filter(Boolean)
}

async function loadCatalog(socketPath, signal, complete) {
  const { projects, persisted, loaded } = await withCodexReader(socketPath, signal, async request => {
    const [projects, persisted] = await Promise.all([readProjects(request), readThreads(request, { useStateDbOnly: !complete })])
    return { projects, persisted, loaded: await readUnlistedLoadedThreads(request, persisted) }
  }, complete ? 90_000 : 15_000)

  const threads = loaded.length ? mergePages(persisted, loaded).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) : persisted
  const paths = [
    ...projects.flatMap(project => project.roots.map(root => root.path)),
    ...threads.map(thread => thread.cwd),
  ]
  const workspacePaths = await resolveWorkspacePaths(paths)
  signal?.throwIfAborted()
  return { result: { projects, threads, workspacePaths, complete }, persisted }
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
    if (!complete && snapshot?.complete && !freshRequired) return { ...snapshot, complete: false }
    if (pending.has(complete)) return pending.get(complete)

    const previous = snapshot
    const refresh = loadCatalog(endpoint, signal, complete).then(async ({ result, persisted }) => {
      if (!complete && snapshot?.complete) {
        if (snapshot !== previous) return snapshot
        // 快速索引已经覆盖已保存的分页历史，保留需要完整扫描的旧记录直到校验完成。
        return { ...result, threads: mergePages(result.threads, snapshot.threads.filter(thread => thread.historyMode !== 'paginated')),
          workspacePaths: { ...snapshot.workspacePaths, ...result.workspacePaths } }
      }
      // 较晚完成的快速索引不能覆盖刚到达的完整清单。
      if (complete || snapshot === previous) {
        snapshot = result
        refreshedAt = Date.now()
      }
      // 新会话发送之前只由 App Server 持有。清单缓存仅记录原生历史中的线程。
      if (complete && cachePath) await saveCatalogCache(cachePath, { ...result, threads: persisted }, signal)
      return snapshot
    }).catch(error => {
      if (complete || signal?.aborted) throw error
      if (snapshot?.complete) return { ...snapshot, complete: false }
      return readCatalog(true)
    }).finally(() => pending.delete(complete))
    pending.set(complete, refresh)
    return refresh
  }
}
