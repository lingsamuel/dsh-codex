import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const maximumWorkspaces = 8
const refreshInterval = 5_000

/** 从编辑器的工作目录或所属的原生线程索引路径，供 DSH 补全使用。 */
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
      const cwd = params.get('cwd')
      if (!threadId && !isAbsolute(cwd ?? '')) {
        return Response.json({ error: '请选择有效的工作目录。' }, { status: 400, headers })
      }
      const signal = AbortSignal.any([request.signal, ownerSignal])
      try {
        // 原生会话继续按已有作用域查找。空草稿使用目录选择器提供的 Host 路径。
        const root = threadId ? (await readScope(threadId))?.workspaceRoot
          : (await stat(cwd).catch(() => null))?.isDirectory() ? cwd : undefined
        signal.throwIfAborted()
        if (!isAbsolute(root ?? '')) {
          return Response.json({ error: '找不到 Codex 工作目录。' }, { status: 404, headers })
        }
        return Response.json(await searchFor(root).list(params.get('query') ?? '', signal), { headers })
      } catch {
        return Response.json({ error: '无法读取 Codex 工作区的路径候选。' }, { status: 503, headers })
      }
    },
  }
}
