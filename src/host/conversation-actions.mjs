import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { CodexRpcError, readCodexPages, withCodexReader } from './app-server.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { replaceUserInputText } from '../shared/user-input.js'
import { readProjects } from './catalog.mjs'
import { hasNoMaterializedHistory } from './live-history.mjs'

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function badRequest(message) {
  return new CodexRpcError({ code: -32602, message })
}

function conflict(reason, message) {
  return new CodexRpcError({ code: -32600, message, data: { reason } })
}

function required(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(message)
  return value
}

function promptInput(input) {
  if (!Array.isArray(input) || input.some(part => part?.type !== 'text' || typeof part.text !== 'string')
    || !input.some(part => part.text.trim())) throw badRequest('请输入消息内容。')
  return input.map(({ text, text_elements }) => ({ type: 'text', text, text_elements: text_elements ?? [] }))
}

/** 从原生队列读取当前顺序，供初次投影和队列操作复用。不会加载线程。 */
export function readConversationQueue(request, threadId) {
  return readCodexPages(cursor => request('thread/queue/list', {
    threadId, limit: 100, ...(cursor != null && { cursor }),
  }))
}

async function addressableThread(request, threadId) {
  const { thread } = await request('thread/read', { threadId })
  if (thread.archived || thread.ephemeral || thread.canAcceptDirectInput === false) {
    throw conflict('thread-unavailable', '此会话无法从网页直接操作。')
  }
  return thread
}

async function loadedThread(request, threadId) {
  const thread = await addressableThread(request, threadId)
  if (thread.status?.type === 'notLoaded') throw conflict('not-loaded', '请先加载 Codex 会话。')
}

async function workspaceThread(thread) {
  return { thread, workspacePaths: await resolveWorkspacePaths([thread.cwd]) }
}

/** DSH 提名的草稿只有仍是原生空线程、且不含待发内容时才能复用。 */
async function reusableDraft(request, threadId, cwd, projectId) {
  if (!threadId) return
  const result = await request('thread/read', { threadId }).catch(error => {
    if (error instanceof CodexRpcError && (error.code === -32600 || error.code === -32602)) return null
    throw error
  })
  const thread = result?.thread
  if (!thread || thread.status?.type !== 'idle' || thread.historyMode !== 'paginated' || thread.name || thread.preview
    || thread.ephemeral || thread.archived || (thread.projectId ?? null) !== (projectId ?? null)) return
  if (thread.cwd !== cwd) {
    const paths = await resolveWorkspacePaths([thread.cwd, cwd])
    if ((paths[thread.cwd] ?? thread.cwd) !== (paths[cwd] ?? cwd)) return
  }
  if ((await readConversationQueue(request, threadId)).length) return
  try {
    await request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' })
  } catch (error) {
    if (hasNoMaterializedHistory(error)) return thread
    throw error
  }
}

async function openProject(request, cwd) {
  const workspacePaths = await resolveWorkspacePaths([cwd])
  const path = workspacePaths[cwd] ?? cwd
  const projects = await readProjects(request)
  const existing = projects.find(project => project.roots.some(root => root.path === path || root.path === cwd))
  if (existing) return { project: existing, workspacePaths }
  const { project } = await request('project/create', {
    name: basename(path) || path, roots: [{ path }], idempotencyKey: randomUUID(),
  })
  return { project, workspacePaths }
}

function missingQueueItem() {
  return conflict('queue-item-not-found', '这条消息已离开待发队列。')
}

function steerUnavailable(error) {
  return error instanceof CodexRpcError && (error.message === 'no active turn to steer'
    || error.message.startsWith('expected active turn id ')
    || error.data?.codexErrorInfo?.activeTurnNotSteerable !== undefined
    || error.message === 'cannot steer a review turn' || error.message === 'cannot steer a compact turn')
}

async function steer(request, params) {
  try {
    return await request('turn/steer', params)
  } catch (error) {
    if (steerUnavailable(error)) throw conflict('steer-unavailable', error.message)
    throw error
  }
}

async function deleteQueued(request, params) {
  const result = await request('thread/queue/delete', params)
  if (!result.deleted) throw missingQueueItem()
  return result
}

async function queueAction(request, threadId, { operation, queuedSubmissionId, expectedTurnId, text }) {
  if (operation === 'list') return { data: await readConversationQueue(request, threadId) }
  if (operation === 'start') {
    return request('thread/queue/start', {
      threadId, ...(queuedSubmissionId !== undefined && {
        queuedSubmissionId: required(queuedSubmissionId, '缺少待发消息 ID。'),
      }),
    })
  }
  if (operation !== 'edit' && operation !== 'steer' && operation !== 'remove') throw badRequest('无效的队列操作。')
  required(queuedSubmissionId, '缺少待发消息 ID。')
  const target = { threadId, queuedSubmissionId }
  if (operation === 'remove') return deleteQueued(request, target)
  if (operation === 'edit' && typeof text !== 'string') throw badRequest('缺少待发消息正文。')
  if (operation === 'steer') required(expectedTurnId, '缺少当前轮次 ID。')
  const item = (await readConversationQueue(request, threadId)).find(entry => entry.id === queuedSubmissionId)
  if (!item) throw missingQueueItem()

  if (operation === 'edit') {
    const input = replaceUserInputText(item.input, text)
    if (!input.length) throw badRequest('请输入消息内容。')
    try {
      return await request('thread/queue/update', { ...target, input })
    } catch (error) {
      if (error instanceof CodexRpcError && error.message.startsWith('queued submission not found:')) throw missingQueueItem()
      throw error
    }
  }

  // 先原子取走待发项，以免轮次结束时同一条消息又被 Codex 自动领取。
  await deleteQueued(request, target)
  const input = { threadId, input: item.input, clientUserMessageId: item.clientUserMessageId }
  try {
    return await steer(request, { ...input, expectedTurnId })
  } catch (error) {
    // 原生明确拒绝时恢复待发内容。断线时无法判断是否已插话，不自动重发。
    if (!(error instanceof CodexRpcError)) throw conflict('queue-steer-unknown', '无法确认插话是否已发送。请先检查会话。')
    try {
      await request('thread/queue/add', input)
    } catch {
      throw conflict('queue-steer-not-restored', '插话失败，无法自动恢复待发消息。')
    }
    throw error
  }
}

/** 只接受网页原生输入控件需要的字段，线程配置和审批策略始终由 Codex 决定。 */
export function createConversationActionRoute(socketPath, ownerSignal) {
  const creatingProjects = new Map()
  return {
    path: '/api/codex/conversation-action',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const fields = await request.json().catch(() => null)
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      const { action, threadId, cwd, projectId, mode, input, clientUserMessageId, expectedTurnId, turnId, reuseThreadId } = fields ?? {}
      try {
        if (action === 'project') {
          if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw badRequest('请选择绝对路径的工作目录。')
          if (!creatingProjects.has(cwd)) {
            const pending = withCodexReader(socketPath, signal, rpc => openProject(rpc, cwd))
              .finally(() => creatingProjects.delete(cwd))
            creatingProjects.set(cwd, pending)
          }
          return json(await creatingProjects.get(cwd))
        }
        if (action === 'create') {
          if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw badRequest('请选择绝对路径的工作目录。')
          if (projectId !== undefined) required(projectId, '项目 ID 无效。')
          if (reuseThreadId !== undefined) required(reuseThreadId, '草稿会话 ID 无效。')
          return json(await withCodexReader(socketPath, signal, async rpc => {
            const reused = await reusableDraft(rpc, reuseThreadId, cwd, projectId)
            const thread = reused ?? (await rpc('thread/start', { cwd, historyMode: 'paginated', ...(projectId && { projectId }) })).thread
            return workspaceThread({ ...thread, blank: true })
          }))
        }
        if (!['resume', 'prompt', 'cancel', 'queue'].includes(action)) throw badRequest('无效的会话操作。')
        required(threadId, '缺少 Codex 线程 ID。')
        if (action === 'prompt') {
          if (mode !== 'queue' && mode !== 'steer') throw badRequest('无效的发送方式。')
          const params = { threadId, input: promptInput(input), clientUserMessageId: required(clientUserMessageId, '缺少消息 ID。') }
          if (mode === 'steer' && expectedTurnId !== undefined) required(expectedTurnId, '当前轮次 ID 无效。')
          return json(await withCodexReader(socketPath, signal, async rpc => {
            await loadedThread(rpc, threadId)
            if (mode === 'steer' && expectedTurnId) {
              try {
                return await steer(rpc, { ...params, expectedTurnId })
              } catch (error) {
                if (error.data?.reason !== 'steer-unavailable') throw error
              }
            }
            // turn/start 也能向活动轮次插话。原生队列能处理竞争，并在空闲时自行启动。
            return rpc('thread/queue/add', params)
          }))
        }
        if (action === 'cancel') {
          required(turnId, '缺少当前轮次 ID。')
          return json(await withCodexReader(socketPath, signal, async rpc => {
            await loadedThread(rpc, threadId)
            return rpc('turn/interrupt', { threadId, turnId })
          }))
        }
        return json(await withCodexReader(socketPath, signal, async rpc => {
          if (action === 'queue') return queueAction(rpc, threadId, fields)
          let thread = await addressableThread(rpc, threadId)
          // 已加载的线程继续由现有的客户端持有，避免重复恢复覆盖运行时标识。
          if (thread.status?.type === 'notLoaded') ({ thread } = await rpc('thread/resume', { threadId, excludeTurns: true }))
          return workspaceThread(thread)
        }))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          const reason = error.data?.reason
          return json({ error: error.message, ...(reason && { reason }) }, reason ? 409
            : error.code === -32600 || error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法连接 Codex App Server。' }, 503)
      }
    },
  }
}
