import { pinnedSectionId } from '../shared/thread-sections.js'
import { CodexRpcError, readCodex, withCodexReader } from './app-server.mjs'
import { updateModelSelection } from './models.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { editedInput, sendAfterRevert } from './thread-edit.mjs'
import { readThreads } from './catalog.mjs'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** 只开放会话管理动作。浏览器不能指定要转发的 RPC 或改变原生线程控制权。 */
export function createThreadActionRoute(socketPath, ownerSignal) {
  const historyActions = new Set()
  return {
    path: '/api/codex/thread-action',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const input = await request.json().catch(() => null)
      const { threadId, action, expectedRevision, name, pinned, provider, model, reasoningEffort,
        stopActivity, lastTurnId, beforeTurnId, itemId, text, headTurnId } = input ?? {}
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
      } else if (action === 'archive' || action === 'unarchive' || action === 'delete') {
        method = `thread/${action}`
        params = { threadId }
      } else if (action === 'fork' && (lastTurnId === undefined || (typeof lastTurnId === 'string' && lastTurnId.trim()))) {
        method = 'thread/fork'
        params = { threadId, excludeTurns: true, deferGoalContinuation: true, ...(lastTurnId && { lastTurnId }) }
      } else if ((action === 'revert' || (action === 'edit' && typeof itemId === 'string' && itemId.trim()
        && typeof text === 'string' && typeof headTurnId === 'string' && headTurnId.trim()))
        && typeof beforeTurnId === 'string' && beforeTurnId.trim()) {
        method = 'thread/revert'
        params = { threadId, beforeTurnId }
      } else if (action !== 'model' || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model
        || (reasoningEffort !== undefined && typeof reasoningEffort !== 'string')) {
        return json({ error: '无效的会话管理操作。' }, 400)
      }

      const modifiesHistory = action === 'edit' || action === 'revert'
      if (modifiesHistory) {
        if (historyActions.has(threadId)) return json({ error: '此会话正在修改历史。' }, 409)
        historyActions.add(threadId)
      }
      try {
        if (action === 'model') {
          return json(await withCodexReader(socketPath, signal,
            request => updateModelSelection(request, { threadId, provider, model, reasoningEffort })))
        }
        if (modifiesHistory || (action === 'archive' && stopActivity !== true)) {
          return await withCodexReader(socketPath, signal, async request => {
            const replacement = action === 'edit' && await editedInput(request, threadId, beforeTurnId, itemId, text)
            if (replacement) {
              // 像原生 CLI 编辑一样，按打开编辑框时的历史头检查并发写入。
              const { data } = await request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
              if (data[0]?.id !== headTurnId) return json({ error: '打开编辑器后会话历史已有变化。请复制草稿并重新打开编辑。' }, 409)
            }
            const { thread } = await request('thread/read', { threadId })
            if (action === 'archive') {
              const activity = await archiveActivity(request, thread)
              if (activity.length) return json({ reason: 'archiveActive', activity, error: '会话仍有运行中的操作。' }, 409)
            }
            // 回退会替换运行时。先查当前状态，避免在浏览时自动恢复线程或中断已开始的 CLI 轮次。
            if (modifiesHistory) {
              const status = thread.status?.type
              if (status === 'notLoaded') return json({ error: 'Codex 尚未加载此会话。请先从输入框继续。' }, 409)
              if (status === 'active') return json({ error: '会话仍在运行。请在 Codex CLI 中停止当前轮次，或等待它结束。' }, 409)
              if (status !== 'idle' || thread.historyMode !== 'paginated' || thread.archived
                || thread.ephemeral || thread.canAcceptDirectInput === false) {
                return json({ error: '修改历史需要一个支持分页历史且可直接操作的空闲会话。' }, 409)
              }
            }
            if (!replacement) return json(await request(method, params))
            try {
              await request(method, params)
            } catch (error) {
              // 原生保存后还要重建运行时。如果这一步断线或失败，不能假定旧历史仍存在。
              if (error instanceof CodexRpcError && [-32602, -32601, -32600].includes(error.code)) throw error
              return json({ error: '无法确认回退是否完成。请先核对当前会话。' }, 409)
            }
            const sent = await sendAfterRevert(request, threadId, replacement)
            if (sent.error) return json({ error: sent.error }, 409)
            return json(sent)
          })
        }
        const result = await readCodex(method, params, socketPath, signal)
        if (action === 'fork' || action === 'unarchive') {
          return json({ ...result, workspacePaths: await resolveWorkspacePaths([result.thread.cwd]) })
        }
        return json(result)
      } catch (error) {
        if (error instanceof CodexRpcError) {
          if (error.data?.reason === 'readStateConflict') {
            return json({ error: '阅读状态已更新。', readState: error.data.readState }, 409)
          }
          if (error.data?.reason === 'modelSelectionUnavailable') return json({ error: error.message }, 409)
          return json({ error: error.message }, error.code === -32600 || error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法连接 Codex App Server。' }, 503)
      } finally {
        if (modifiesHistory) historyActions.delete(threadId)
      }
    },
  }
}

async function archiveActivity(request, thread) {
  if (thread.status?.type === 'active') return [{ kind: 'turn' }]
  // Codex 归档会结束子代理，即使该代理已归档，原生协作运行时也可能仍在运行。
  const pages = await Promise.all([false, true].map(archived => readThreads(request, {
    ancestorThreadId: thread.id, sourceKinds: ['subAgent'], archived, useStateDbOnly: true,
  })))
  const items = pages.flat().filter(child => child.status?.type === 'active')
    .map(child => ({ id: child.id, label: child.agentNickname || child.agentRole || child.name }))
  return items.length ? [{ kind: 'subagent', items }] : []
}
