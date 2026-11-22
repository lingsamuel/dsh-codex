import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { readProjectSnapshot } from './catalog.mjs'

const methods = { rename: 'project/update', move: 'project/move', delete: 'project/delete' }

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** 用原生项目列表确认写入，并保留 Codex 返回的排序。 */
export function createProjectActionRoute(socketPath, ownerSignal) {
  return {
    path: '/api/codex/project-action',
    methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const { action, projectId, name, beforeProjectId } = (await request.json().catch(() => null)) ?? {}
      if (!Object.hasOwn(methods, action) || typeof projectId !== 'string' || !projectId.trim()
        || (action === 'rename' && (typeof name !== 'string' || !name.trim()))
        || (action === 'move' && beforeProjectId != null && (typeof beforeProjectId !== 'string' || !beforeProjectId.trim()))) {
        return json({ error: '无效的项目操作。' }, 400)
      }
      const params = { projectId }
      if (action === 'rename') params.name = name.trim()
      if (action === 'move' && beforeProjectId != null) params.beforeProjectId = beforeProjectId
      const signal = ownerSignal ? AbortSignal.any([ownerSignal, request.signal]) : request.signal
      try {
        return json(await withCodexReader(socketPath, signal, async rpc => {
          await rpc(methods[action], params)
          return readProjectSnapshot(rpc)
        }))
      } catch (error) {
        if (error instanceof CodexRpcError) return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        return json({ error: '无法确认 Codex 项目操作。' }, 503)
      }
    },
  }
}
