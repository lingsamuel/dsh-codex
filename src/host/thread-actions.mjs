import { pinnedSectionId } from '../shared/thread-sections.js'
import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { updateModelSelection } from './models.mjs'
import { submissionRuntime, validateSubmissionSettings } from './conversation-actions.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { readEditableInput, sendAfterRevert } from './thread-edit.mjs'
import { readThreads } from './catalog.mjs'
import { createThreadSubmissionQueue, resumeThread, unarchiveForSubmission } from './thread-runtime.mjs'
import { readLatestTurn } from './live-history.mjs'
import { replaceUserInputText, userInputText } from '../shared/user-input.js'
import { resolveInputSkills } from './skills.mjs'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

function historyUnavailable(thread, allowArchived = false) {
  if (thread.status?.type === 'active') return '会话仍在运行。请停止当前轮次，或等待它结束。'
  if (thread.historyMode !== 'paginated' || (!allowArchived && thread.archived) || thread.ephemeral || thread.canAcceptDirectInput === false
    || !['idle', 'notLoaded'].includes(thread.status?.type)) {
    return '修改历史需要一个支持分页历史且可直接操作的空闲会话。'
  }
}

/** 只开放会话管理动作。浏览器不能指定要转发的 RPC 或改变原生线程控制权。 */
export function createThreadActionRoute(socketPath, ownerSignal, submit = createThreadSubmissionQueue(), backgroundTerminals, permissions) {
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
        stopActivity, lastTurnId, beforeTurnId, itemId, text, headTurnId, modelDraft, permissionDraft, processId } = input ?? {}
      if (typeof threadId !== 'string' || !threadId.trim()) return json({ error: '缺少 Codex 线程 ID。' }, 400)
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      let method
      let params
      if (action === 'read' || action === 'unread') {
        if (typeof expectedRevision !== 'string' || !expectedRevision) return json({ error: '缺少阅读回执版本。' }, 400)
        method = 'thread/readState/update'
        params = { threadId, operation: { type: action }, expectedRevision }
      } else if (action === 'terminate-background-terminal' && backgroundTerminals) {
        if (typeof processId !== 'string' || !processId.trim()) return json({ error: '缺少 Codex 后台进程 ID。' }, 400)
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
        && typeof text === 'string')) && typeof headTurnId === 'string' && headTurnId.trim()
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
        if (action === 'terminate-background-terminal') {
          return json(await backgroundTerminals.terminate(threadId, processId, signal))
        }
        if (action === 'model') {
          return json(await submit(threadId, () => withCodexReader(socketPath, signal,
            request => updateModelSelection(request, { threadId, provider, model, reasoningEffort }))))
        }
        if (modifiesHistory || (action === 'archive' && stopActivity !== true)) {
          const run = () => withCodexReader(socketPath, signal, async request => {
            const { thread: initial } = await request('thread/read', { threadId })
            if (action === 'archive') {
              const activity = await archiveActivity(request, initial)
              if (activity.length) return json({ reason: 'archiveActive', activity, error: '会话仍有运行中的操作。' }, 409)
              return json(await request(method, params))
            }

            const unarchive = input.unarchive === true
            const unavailable = historyUnavailable(initial, unarchive)
            if (unavailable) return json({ error: unavailable }, 409)
            const stale = async () => (await readLatestTurn(request, threadId, 'notLoaded'))?.id !== headTurnId
            const historyChanged = () => json({ error: '会话历史已有变化。请核对记录后重新发起操作。' }, 409)
            if (await stale()) return historyChanged()
            const original = action === 'edit' && await readEditableInput(request, threadId, beforeTurnId, itemId)
            const replacement = original && replaceUserInputText(original, text)
            if (replacement && !replacement.length) return json({ error: '请输入消息内容。' }, 400)
            const draft = { modelDraft, permissionDraft }
            if (replacement) await validateSubmissionSettings(request, initial, draft, permissions)
            if (unarchive && !replacement && beforeTurnId !== headTurnId) {
              // 只在归档状态可能改变之前确认所选回复轮次仍存在。
              const { data } = await request('thread/items/list', { threadId, turnId: beforeTurnId, limit: 1 })
              if (!data.length) return historyChanged()
            }

            const thread = unarchive ? await unarchiveForSubmission(request, initial) : initial
            if (unarchive) {
              const unavailable = historyUnavailable(thread)
              if (unavailable) return json({ error: unavailable }, 409)
              if (await stale()) return historyChanged()
            }
            const cold = thread.status.type === 'notLoaded'
            const hasQueued = async () => (await request('thread/queue/list', { threadId, limit: 1 })).data.length > 0
            const queued = () => json({ error: '请先处理待发消息，再修改对话记录。' }, 409)
            // 冷恢复可能自行领取待发项。已取消归档的线程也可能被别的客户端先恢复。
            if ((cold || unarchive) && await hasQueued()) return queued()
            let runtime = thread
            let permission
            if (replacement) ({ runtime, permission } = await submissionRuntime(request, thread, draft, signal, permissions))
            else if (cold) await resumeThread(request, thread)
            if (cold || unarchive || (replacement && (modelDraft || permissionDraft))) {
              const { thread: current } = await request('thread/read', { threadId })
              if (current.status?.type !== 'idle' || historyUnavailable(current)) {
                return json({ error: historyUnavailable(current) ?? '会话状态已变化，请重试。' }, 409)
              }
              if (unarchive && await hasQueued()) return queued()
              if (await stale()) return historyChanged()
              runtime = current
            }
            if (!replacement) return json(await request(method, params))
            // 恢复可能改变工作目录。在实际目录解析技能，成功后再回退历史。
            const revised = await resolveInputSkills(request, replacement, () => runtime.cwd ?? thread.cwd, userInputText(original))
            if (!revised.length) return json({ error: '请输入消息内容。' }, 400)
            try {
              await request(method, params)
            } catch (error) {
              // 原生保存后还要重建运行时。如果这一步断线或失败，不能假定旧历史仍存在。
              if (error instanceof CodexRpcError && [-32602, -32601, -32600].includes(error.code)) throw error
              return json({ error: '无法确认回退是否完成。请先核对当前会话。' }, 409)
            }
            const sent = await sendAfterRevert(request, threadId, revised, signal)
            if (sent.error) return json({ error: sent.error }, 409)
            return json(permission ? { ...sent, permission } : sent)
          })
          return await (modifiesHistory ? submit(threadId, run) : run())
        }
        const restoreForFork = action === 'fork' && input.unarchive === true
        const run = () => withCodexReader(socketPath, signal, async request => {
          if (restoreForFork) {
            const { thread } = await request('thread/read', { threadId })
            await unarchiveForSubmission(request, thread)
          }
          // 分叉只需要可读取的原生历史。源线程不需要恢复运行时。
          return request(method, params)
        })
        const result = await (action === 'rename' || restoreForFork ? submit(threadId, run) : run())
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
