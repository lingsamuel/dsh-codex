import { CodexRpcError, readCodex } from './app-server.mjs'

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

/** 将只读入口注册在 DSH 的受保护 API 下，并直接返回 Codex 的分页结果。 */
export function createHistoryRoutes(socketPath = process.env.DSH_CHATGPT_SOCKET) {
  const route = (path, method, parameters) => ({
    path: `/api/codex/${path}`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const params = parameters(new URL(request.url).searchParams)
      if (params === null) return json({ error: '缺少 Codex 线程 ID。' }, 400)

      try {
        return json(await readCodex(method, params, socketPath, request.signal))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          if (method === 'project/list' && error.code === -32601) {
            return json({ data: [], nextCursor: null })
          }
          return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法读取 Codex。请检查当前环境的共享 App Server 是否正在运行。' }, 503)
      }
    },
  })

  return [
    route('projects', 'project/list', query => ({
      limit: 60,
      ...optionalParams(query, ['cursor']),
    })),
    route('threads', 'thread/list', query => ({
      limit: 60,
      sortKey: 'updated_at',
      modelProviders: [],
      ...optionalParams(query, ['cwd', 'cursor', 'projectId']),
    })),
    route('turns', 'thread/turns/list', query => {
      const threadId = query.get('threadId')
      if (!threadId) return null
      return {
        threadId,
        limit: 25,
        sortDirection: 'desc',
        itemsView: 'full',
        ...optionalParams(query, ['cursor']),
      }
    }),
  ]
}
