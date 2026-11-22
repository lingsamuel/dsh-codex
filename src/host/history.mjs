import { CodexRpcError, readCodex } from './app-server.mjs'
import { createCatalogReader, readProjectPage } from './catalog.mjs'

function optionalParams(query, keys) {
  const result = {}
  for (const key of keys) {
    if (query.has(key)) result[key] = query.get(key)
  }
  return result
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** 将只读入口注册在 DSH 的受保护 API 下。 */
export function createHistoryRoutes(socketPath = process.env.DSH_CHATGPT_SOCKET, ownerSignal, cacheDirectory) {
  const readCatalog = createCatalogReader(socketPath, ownerSignal, cacheDirectory)
  const route = (path, read) => ({
    path: `/api/codex/${path}`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return json(await read(new URL(request.url).searchParams, request.signal))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法读取 Codex。请检查当前环境的共享 App Server 是否正在运行。' }, 503)
      }
    },
  })
  const native = (method, parameters) => (query, signal) => readCodex(method, parameters(query), socketPath, signal)

  return [
    route('catalog', query => readCatalog(query.get('complete') === '1')),
    route('projects', (query, signal) => readProjectPage(
      (method, params) => readCodex(method, params, socketPath, signal),
      { limit: 60, ...optionalParams(query, ['cursor']) },
    )),
    route('threads', native('thread/list', query => ({
      limit: 60,
      sortKey: 'updated_at',
      modelProviders: [],
      ...optionalParams(query, ['cwd', 'cursor', 'projectId']),
    }))),
    route('turns', native('thread/turns/list', query => {
      const threadId = query.get('threadId')
      if (!threadId) throw new CodexRpcError({ code: -32602, message: '缺少 Codex 线程 ID。' })
      return {
        threadId,
        limit: 25,
        sortDirection: 'desc',
        itemsView: 'full',
        ...optionalParams(query, ['cursor']),
      }
    })),
  ]
}
