import { isAbsolute } from 'node:path'

const maximumWorkspaces = 8
const refreshInterval = 5_000

/** 只向原生补全组件提供路径。工作目录来自请求所属的 Codex 线程。 */
export function createFileReferenceRoute(readScope, createSearch, ownerSignal) {
  const searches = new Map()
  ownerSignal.addEventListener('abort', () => {
    for (const { search } of searches.values()) search.dispose()
    searches.clear()
  }, { once: true })

  function searchFor(cwd) {
    const now = Date.now()
    let entry = searches.get(cwd)
    if (!entry) entry = { search: createSearch(cwd), refreshedAt: now }
    if (now - entry.refreshedAt >= refreshInterval) {
      entry.search.invalidate()
      entry.refreshedAt = now
    }
    searches.delete(cwd)
    searches.set(cwd, entry)
    if (searches.size > maximumWorkspaces) {
      const [oldest, expired] = searches.entries().next().value
      expired.search.dispose()
      searches.delete(oldest)
    }
    return entry.search
  }

  return {
    path: '/api/codex/file-references', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'Cache-Control': 'no-store' }
      const params = new URL(request.url).searchParams
      const threadId = params.get('threadId')
      if (!threadId) return Response.json({ error: '缺少 Codex 线程 ID。' }, { status: 400, headers })
      const signal = AbortSignal.any([request.signal, ownerSignal])
      try {
        const scope = await readScope(threadId)
        signal.throwIfAborted()
        if (!scope || !isAbsolute(scope.workspaceRoot)) {
          return Response.json({ error: '找不到 Codex 会话工作目录。' }, { status: 404, headers })
        }
        return Response.json(await searchFor(scope.workspaceRoot).list(params.get('query') ?? '', signal), { headers })
      } catch {
        return Response.json({ error: '无法读取 Codex 工作区的路径候选。' }, { status: 503, headers })
      }
    },
  }
}
