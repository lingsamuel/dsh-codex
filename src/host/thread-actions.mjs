import { pinnedSectionId } from '../shared/thread-sections.js'
import { CodexRpcError, readCodex, withCodexReader } from './app-server.mjs'
import { updateModelSelection } from './models.mjs'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** 只开放会话管理动作。浏览器不能指定要转发的 RPC 或改变原生线程控制权。 */
export function createThreadActionRoute(socketPath, ownerSignal) {
  return {
    path: '/api/codex/thread-action',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const input = await request.json().catch(() => null)
      const { threadId, action, expectedRevision, name, pinned, provider, model, reasoningEffort } = input ?? {}
      if (typeof threadId !== 'string' || !threadId.trim()) return json({ error: '缺少 Codex 线程 ID。' }, 400)
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      let method
      let params
      if (action === 'read' || action === 'unread') {
        if (typeof expectedRevision !== 'string' || !expectedRevision) return json({ error: '缺少阅读回执版本。' }, 400)
        method = 'thread/readState/update'
        params = { threadId, operation: { type: action }, expectedRevision }
      } else if (action === 'rename' && typeof name === 'string' && name.trim()) {
        method = 'thread/name/set'
        params = { threadId, name }
      } else if (action === 'pin' && typeof pinned === 'boolean') {
        method = 'thread/section/move'
        params = { threadId, sectionId: pinned ? pinnedSectionId : null }
      } else if (action !== 'model' || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model
        || (reasoningEffort !== undefined && typeof reasoningEffort !== 'string')) {
        return json({ error: '无效的会话管理操作。' }, 400)
      }

      try {
        if (action === 'model') {
          return json(await withCodexReader(socketPath, signal,
            request => updateModelSelection(request, { threadId, provider, model, reasoningEffort })))
        }
        return json(await readCodex(method, params, socketPath, signal))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          if (error.data?.reason === 'readStateConflict') {
            return json({ error: '阅读状态已更新。', readState: error.data.readState }, 409)
          }
          if (error.data?.reason === 'modelSelectionUnavailable') return json({ error: error.message }, 409)
          return json({ error: error.message }, error.code === -32600 || error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法连接 Codex App Server。' }, 503)
      }
    },
  }
}
