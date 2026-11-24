import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { replaceUserInputText, userInputText } from '../shared/user-input.js'
import { isComposerImageUrl } from '../shared/composer-images.js'
import { fileAttachmentOf, splitFileAttachmentInput } from '../shared/file-attachments.js'
import { createProjectOpener } from './project-actions.mjs'
import { hasNoMaterializedHistory, readLatestTurn, readThreadTurns } from './live-history.mjs'
import { updateModelSelection, validateModelDraft } from './models.mjs'
import { addressableThread, createThreadSubmissionQueue, findThreadSubmission, readConversationQueue, resumeThread,
  unarchiveForSubmission, waitForThreadActivity } from './thread-runtime.mjs'
import { createThreadTitles } from './thread-titles.mjs'
import { resolveInputSkills } from './skills.mjs'
import { resolveWorktreeCwd, validateWorktreeSelection, worktreeConflict } from './git-worktrees.mjs'
import { createQueuedSteers } from './queued-steers.mjs'
import { isLocalSessionId } from '../shared/local-session.js'
import { createFirstSubmission, explicitlyRejected, waitForFirstReceipt } from './first-submission.mjs'
import { threadTaskToolsConfig, requireThreadReadTool } from './codex-task-tools-config.mjs'
import { hasThreadReferences, prepareThreadReferences } from '../shared/thread-references.js'

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

function promptInput(input, threadId, resolveFile) {
  if (!Array.isArray(input)) throw badRequest('请输入消息内容。')
  const parts = input.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      if (splitFileAttachmentInput(part).some(fileAttachmentOf)) throw badRequest('请使用上传回执提交附件。')
      return { type: 'text', text: part.text, text_elements: part.text_elements ?? [] }
    }
    if (part?.type === 'image' && isComposerImageUrl(part.url)) return { type: 'image', url: part.url }
    if (part?.type === 'file') {
      const file = resolveFile?.(threadId, part.receiptId)
      if (file) return file
      throw badRequest('附件上传回执已失效，请重新添加文件。')
    }
    throw badRequest('消息只接受文本、内嵌图片和已上传的文件。')
  })
  if (!parts.some(part => part.type === 'image' || part.text.trim())) throw badRequest('请输入消息内容。')
  return parts
}

async function requireActiveThread(request, threadId) {
  const thread = await addressableThread(request, threadId)
  if (thread.status?.type !== 'active') throw conflict('turn-unavailable', '原轮次已结束或不再运行。')
  return thread
}

async function workspaceThread(thread, permission) {
  return { thread, workspacePaths: await resolveWorkspacePaths([thread.cwd]), ...(permission && { permission }) }
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

function missingQueueItem() {
  return conflict('queue-item-not-found', '这条消息已离开待发队列。')
}

function steerUnavailable(error) {
  return error instanceof CodexRpcError && (error.message === 'no active turn to steer'
    || error.message.startsWith('expected active turn id ')
    || error.data?.codexErrorInfo?.activeTurnNotSteerable !== undefined
    || error.message === 'cannot steer a review turn' || error.message === 'cannot steer a compact turn')
}

/** 向指定的原生轮次插话，并区分明确拒绝接纳与投递结果未知。 */
export async function steerTurn(request, params) {
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

/** 原生暂停队列时，空闲发送仍可启动本次唯一的消息。旧待发项由用户显式继续。 */
export async function startOnlyQueuedMessage(request, threadId, queuedSubmissionId, reportQueuedForLater) {
  const readHead = () => request('thread/queue/list', { threadId, limit: 2 })
  try {
    // 入队期间，CLI 或网页可能刚好结束上一轮。用接纳消息后的状态决定是否启动。
    const { thread } = await request('thread/read', { threadId })
    const idle = thread.status?.type === 'idle'
    if (!idle && !reportQueuedForLater) return {}
    let queue = await readHead()
    if (idle && queue.data.length === 1 && queue.data[0].id === queuedSubmissionId && queue.nextCursor == null) {
      try {
        return { started: await request('thread/queue/start', { threadId, queuedSubmissionId }) }
      } catch {
        if (!reportQueuedForLater) return {}
        // 原生也可能刚领取消息。只有重新读到仍在等待的条目才让队列接手气泡。
        queue = await readHead()
      }
    }
    if (reportQueuedForLater) {
      const containsSubmission = items => items.some(item => item.id === queuedSubmissionId)
      if (containsSubmission(queue.data) || (queue.nextCursor != null && containsSubmission(await readConversationQueue(request, threadId)))) {
        return { queuedForLater: true }
      }
    }
  } catch {
    // 入队已确认，等待实时队列和历史继续同步。
  }
  return {}
}

/** 在变更归档状态或恢复前确认所选设置仍可用于该线程。 */
export async function validateSubmissionSettings(request, thread, { modelDraft, permissionDraft }, permissions) {
  validateModelDraft(thread, modelDraft)
  if (permissionDraft !== undefined) {
    if (!permissions) throw badRequest('Codex 权限选择不可用。')
    await permissions.validateSelection(request, thread.cwd, required(permissionDraft, '缺少 Codex 权限预设。'))
  }
}

async function submissionThread(request, threadId, fields, permissions) {
  const { unarchive } = fields
  const current = await addressableThread(request, threadId, unarchive === true)
  await validateSubmissionSettings(request, current, fields, permissions)
  return unarchive === true ? unarchiveForSubmission(request, current) : current
}

/** 原生可能在冷恢复时启动旧队列，因此草稿设置随恢复请求一起应用。 */
export async function submissionRuntime(request, thread, { modelDraft, permissionDraft }, signal, permissions, taskConfig, creationPermission) {
  const config = { ...taskConfig, ...(modelDraft?.reasoningEffort && { model_reasoning_effort: modelDraft.reasoningEffort }) }
  const settings = {
    ...(modelDraft && { model: modelDraft.model }),
    ...(Object.keys(config).length && { config }),
    ...(permissionDraft && { permissions: permissionDraft }),
  }
  let permission = creationPermission
  const runtime = await resumeThread(request, thread, (id, result) => {
    const confirmed = permissions?.remember(id, result)
    if (permissionDraft) permission = confirmed
  }, settings)
  if (permissionDraft && permission?.profileId !== permissionDraft) {
    ({ permission } = await permissions.switchPermission(thread.id, permissionDraft, signal))
    if (permission?.source !== 'runtime') throw conflict('permission-not-confirmed', 'Codex 尚未确认草稿权限。')
  }
  if (modelDraft) await updateModelSelection(request, { ...modelDraft, threadId: thread.id }, signal)
  return { runtime, ...(permission && { permission }) }
}

async function startQueued(request, threadId, fields, signal, permissions, scheduleTitle, steers, socketPath) {
  const { queuedSubmissionId } = fields
  if (queuedSubmissionId !== undefined) required(queuedSubmissionId, '缺少待发消息 ID。')
  const thread = await submissionThread(request, threadId, fields, permissions)
  if (steers.find(threadId, queuedSubmissionId)) throw uncertainQueueSteer()
  let permission
  function started(result) {
    if (result.turn?.id) scheduleTitle(thread, target.clientUserMessageId, result.turn.id)
    return permission ? { ...result, permission } : result
  }
  const hasDraft = fields.modelDraft !== undefined || fields.permissionDraft !== undefined
  const preparesRuntime = thread.status?.type === 'notLoaded' || fields.unarchive === true || hasDraft
  const queue = await readConversationQueue(request, threadId)
  const target = queuedSubmissionId === undefined ? queue[0] : queue.find(item => item.id === queuedSubmissionId)
  if (!target) {
    if (queuedSubmissionId === undefined) return { queueEmpty: true }
    throw missingQueueItem()
  }
  if (steers.find(threadId, target.id)) throw uncertainQueueSteer()
  const references = hasThreadReferences(target.input, threadId)
  const taskConfig = references && thread.status?.type === 'notLoaded' ? await threadTaskToolsConfig(socketPath, signal) : undefined
  if (references && !taskConfig) await requireThreadReadTool(request, threadId)
  if (!preparesRuntime) return started(await request('thread/queue/start', { threadId, queuedSubmissionId: target.id }))
  const ready = await submissionRuntime(request, thread, fields, signal, permissions, taskConfig)
  permission = ready.permission
  async function claimedTurn() {
    const turn = await readLatestTurn(request, threadId, 'full')
    if (turn?.items?.some(item => item.type === 'userMessage' && item.clientId === target.clientUserMessageId)) {
      if (turn.status === 'inProgress') await waitForThreadActivity(request, threadId, signal)
      return { turn }
    }
  }

  // 冷恢复可能已领取队首。始终保留原目标，避免再启动后面的消息。
  if (ready.runtime.status?.type === 'active') {
    const claimed = await claimedTurn()
    if (claimed) return started(claimed)
  }
  if (references && taskConfig) await requireThreadReadTool(request, threadId)
  try {
    const result = await request('thread/queue/start', { threadId, queuedSubmissionId: target.id })
    await waitForThreadActivity(request, threadId, signal)
    return started(result)
  } catch (error) {
    if (!(error instanceof CodexRpcError) || error.code !== -32600
      || !/active or pending turn|queued .*not found/.test(error.message)) throw error
    const deadline = performance.now() + 750
    do {
      const claimed = await claimedTurn()
      if (claimed) return started(claimed)
      await delay(50, undefined, { signal })
    } while (performance.now() < deadline)
    if ((await readConversationQueue(request, threadId)).some(item => item.id === target.id)) throw error
    throw conflict('queue-start-unknown', '待发消息已离开队列，暂无法确认是否开始。请检查会话。')
  }
}

function uncertainQueueSteer() {
  return conflict('queue-steer-unknown', '待发消息的插话结果待确认。')
}

async function restoreQueuedSteer(request, steers, record) {
  const { threadId, item: { input, clientUserMessageId } } = record
  try {
    const restored = await request('thread/queue/add', { threadId, input, clientUserMessageId })
    steers.done(record, { restored: restored.queuedSubmission })
    return restored
  } catch (error) {
    // 原生恢复也可能已写入但未收到回执。仅明确拒绝入队时再次开放恢复。
    const rejected = explicitlyRejected(error)
    steers.setStatus(record, rejected ? 'recoverable' : 'unconfirmed')
    throw rejected ? conflict('queue-steer-not-restored', '插话失败，暂时无法恢复待发消息。') : uncertainQueueSteer()
  }
}

async function queueAction(request, threadId, { operation, queuedSubmissionId, expectedTurnId, text }, steers, scheduleTitle) {
  if (operation === 'list') {
    const { data, steers: records } = await steers.read(request, threadId)
    return { data, ...(records.length && { steers: records }) }
  }
  if (!['edit', 'steer', 'remove', 'restore-steer'].includes(operation)) throw badRequest('无效的队列操作。')
  required(queuedSubmissionId, '缺少待发消息 ID。')
  const target = { threadId, queuedSubmissionId }
  const record = steers.find(threadId, queuedSubmissionId)
  if (operation === 'restore-steer') {
    if (!record) throw missingQueueItem()
    if (record.status !== 'recoverable') throw uncertainQueueSteer()
    await addressableThread(request, threadId)
    await steers.match(request, threadId, await readConversationQueue(request, threadId))
    if (!steers.find(threadId, queuedSubmissionId)) return {}
    steers.setStatus(record, 'steering')
    return restoreQueuedSteer(request, steers, record)
  }
  if (record) throw uncertainQueueSteer()
  if (operation === 'remove') return deleteQueued(request, target)
  if (operation === 'edit' && typeof text !== 'string') throw badRequest('缺少待发消息正文。')
  if (operation === 'steer') required(expectedTurnId, '缺少当前轮次 ID。')
  const item = (await readConversationQueue(request, threadId)).find(entry => entry.id === queuedSubmissionId)
  if (!item) throw missingQueueItem()

  if (operation === 'edit') {
    const edited = replaceUserInputText(item.input, text)
    const resolved = edited === item.input ? edited : await resolveInputSkills(request, edited,
      async () => (await addressableThread(request, threadId)).cwd, userInputText(item.input))
    const input = prepareThreadReferences(resolved, threadId)
    if (!input.length) throw badRequest('请输入消息内容。')
    try {
      return await request('thread/queue/update', { ...target, input })
    } catch (error) {
      if (error instanceof CodexRpcError && error.message.startsWith('queued submission not found:')) throw missingQueueItem()
      throw error
    }
  }

  const thread = await requireActiveThread(request, threadId)
  if (hasThreadReferences(item.input, threadId)) await requireThreadReadTool(request, threadId)
  const current = await readLatestTurn(request, threadId, 'notLoaded')
  if (current?.id !== expectedTurnId || current.status !== 'inProgress') {
    throw conflict('turn-unavailable', '原插话轮次已结束或发生变化。')
  }
  // 先原子取走待发项，以免轮次结束时同一条消息又被 Codex 自动领取。
  const queued = steers.begin(threadId, item, expectedTurnId)
  try {
    await deleteQueued(request, target)
  } catch (error) {
    if (explicitlyRejected(error) && error.data?.reason !== 'queue-item-not-found') {
      steers.done(queued)
      throw error
    }
    steers.setStatus(queued, 'unconfirmed')
    throw uncertainQueueSteer()
  }
  steers.removed(queued)
  // 原生接纳与回执可能分开，拟标题仍由原生历史确认。
  scheduleTitle(thread, item.clientUserMessageId, expectedTurnId, true)
  let result
  try {
    result = await steerTurn(request, { threadId, input: item.input, clientUserMessageId: item.clientUserMessageId, expectedTurnId })
  } catch (error) {
    if (!explicitlyRejected(error)) {
      steers.setStatus(queued, 'unconfirmed')
      throw uncertainQueueSteer()
    }
    await restoreQueuedSteer(request, steers, queued)
    if (error.data?.reason === 'steer-unavailable') throw conflict('turn-unavailable', '原插话轮次已结束或发生变化。')
    throw error
  }
  steers.done(queued)
  return result
}

/** 只接受网页原生输入控件需要的字段，线程配置和审批策略始终由 Codex 决定。 */
export function createConversationActionRoute(socketPath, ownerSignal, submit = createThreadSubmissionQueue(), permissions,
  openProject = createProjectOpener(), enablePlan, steers = createQueuedSteers(), resolveFile,
  submitFirst = createFirstSubmission(socketPath, submit, permissions, openProject),
  scheduleTitle = createThreadTitles(socketPath, ownerSignal, submit).schedule) {
  const worktreeStarts = new Map()

  function withThreadCreation(signal, create) {
    return permissions ? permissions.withThreadCreation(signal, create) : withCodexReader(socketPath, signal, create)
  }

  async function startDraft(rpc, cwd, projectId, retainDraft, options, signal) {
    const started = await rpc('thread/start', {
      cwd, historyMode: 'paginated', ...(projectId && { projectId }), ...options,
      config: await threadTaskToolsConfig(socketPath, signal),
    })
    const permission = retainDraft?.(started)
    return workspaceThread({ ...started.thread, blank: true }, permission)
  }

  async function worktreeStart(sourceId, selection, signal) {
    const key = `${sourceId}:${selection.id}`
    const chosen = JSON.stringify(selection)
    let start = worktreeStarts.get(key)
    if (start) {
      if (start.chosen !== chosen) throw badRequest('工作树选项已变化，请重新选择。')
      return start
    }
    const native = await withThreadCreation(signal, async (rpc, retainDraft) => {
      const source = await addressableThread(rpc, sourceId)
      if (!await reusableDraft(rpc, sourceId, source.cwd, source.projectId)) {
        throw worktreeConflict('worktree-draft-unavailable', '此草稿已不再适合启动工作树会话。')
      }
      const cwd = await resolveWorktreeCwd(source.cwd, selection, signal)
      const projectId = source.projectId ?? (await openProject(rpc, source.cwd)).project.id
      return startDraft(rpc, cwd, projectId, retainDraft, await permissions?.startOptions(rpc, cwd), signal)
    })
    // Git 检出和 thread/start 都可能先于发送失败。保留原生目标，让重试继续原会话。
    start = { chosen, native }
    worktreeStarts.set(key, start)
    if (worktreeStarts.size > 128) worktreeStarts.delete(worktreeStarts.keys().next().value)
    return start
  }

  async function recoverPrompt(rpc, thread, clientUserMessageId, reportQueuedForLater) {
    const result = await findThreadSubmission(rpc, thread.id, clientUserMessageId)
    const { queuedSubmission, turn } = result ?? {}
    if (queuedSubmission) {
      const { started, queuedForLater } = await startOnlyQueuedMessage(rpc, thread.id, queuedSubmission.id, reportQueuedForLater)
      scheduleTitle(thread, clientUserMessageId, started?.turn?.id)
      return { queuedSubmission, ...(queuedForLater && { queuedForLater }) }
    }
    if (turn) scheduleTitle(thread, clientUserMessageId, turn.id)
    return result
  }

  async function recoverWorktreePrompt(rpc, thread, clientUserMessageId, signal, reportQueuedForLater) {
    const result = await waitForFirstReceipt(signal, () => recoverPrompt(rpc, thread, clientUserMessageId, reportQueuedForLater))
    if (result) return result
    throw worktreeConflict('worktree-delivery-unconfirmed', '无法确认工作树会话是否已收到消息，请查看该会话后再继续。')
  }

  async function sendPrompt(threadId, fields, parts, signal, { recover, uncertain, write, creationPermission } = {}) {
    const { clientUserMessageId, mode, expectedTurnId, planMode } = fields
    const reportQueuedForLater = fields.reportQueuedForLater === true
    const end = permissions?.holdCreation?.(threadId)
    try {
      return await withCodexReader(socketPath, signal, async rpc => {
        if (recover) return { ...(await recover(rpc)), ...(planMode && { planMode }) }
        const thread = await submissionThread(rpc, threadId, fields, permissions)
        const references = hasThreadReferences(parts, threadId)
        const taskConfig = references && thread.status?.type === 'notLoaded' ? await threadTaskToolsConfig(socketPath, signal) : undefined
        const { runtime, permission } = await submissionRuntime(rpc, thread, fields, signal, permissions, taskConfig, creationPermission)
        if (references) await requireThreadReadTool(rpc, threadId)
        if (planMode && !(await enablePlan(threadId, signal)).confirmed) {
          throw conflict('plan-mode-unconfirmed', 'Codex 尚未确认计划模式，请重试。')
        }
        const input = prepareThreadReferences(await resolveInputSkills(rpc, parts, () => runtime.cwd ?? thread.cwd), threadId)
        const params = { threadId, input, clientUserMessageId }
        if (runtime.status?.type === 'active' && mode === 'steer' && expectedTurnId) {
          scheduleTitle(runtime, clientUserMessageId, expectedTurnId, true)
          try {
            const result = await steerTurn(rpc, { ...params, expectedTurnId })
            return permission ? { ...result, permission } : result
          } catch (error) {
            if (error.data?.reason !== 'steer-unavailable') throw error
          }
        }
        const result = await (write ? write(rpc, 'thread/queue/add', params) : rpc('thread/queue/add', params)).catch(error => {
          if (!explicitlyRejected(error)) {
            uncertain?.()
            scheduleTitle(thread, clientUserMessageId)
          }
          throw error
        })
        const queuedId = result.queuedSubmission?.id
        const { started, queuedForLater } = queuedId ? await startOnlyQueuedMessage(rpc, threadId, queuedId, reportQueuedForLater) : {}
        scheduleTitle(thread, clientUserMessageId, started?.turn?.id)
        if (thread.status?.type === 'notLoaded' || (write && started)) await waitForThreadActivity(rpc, threadId, signal)
        return { ...result, ...(queuedForLater && { queuedForLater }), ...(permission && { permission }), ...(planMode && { planMode }) }
      })
    } finally {
      end?.()
    }
  }

  return {
    path: '/api/codex/conversation-action',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const fields = await request.json().catch(() => null)
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      const { action, threadId, cwd, mode, input, clientUserMessageId, expectedTurnId, turnId } = fields ?? {}
      let worktreeRecovery
      try {
        if (action === 'project') {
          if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw badRequest('请选择绝对路径的工作目录。')
          return json(await withCodexReader(socketPath, signal, rpc => openProject(rpc, cwd)))
        }
        if (!['prompt', 'cancel', 'queue'].includes(action)) throw badRequest('无效的会话操作。')
        required(threadId, '缺少 Codex 线程 ID。')
        const local = isLocalSessionId(threadId)
        if (local ? action !== 'prompt' : fields.newSession !== undefined) throw badRequest('无效的新会话操作。')
        if (action === 'prompt') {
          if (mode !== 'queue' && mode !== 'steer') throw badRequest('无效的发送方式。')
          const planMode = fields.planMode
          if (planMode !== undefined && (planMode !== 'plan' || mode !== 'queue' || !enablePlan)) throw badRequest('无效的计划提交。')
          const parts = promptInput(input, threadId, resolveFile)
          required(clientUserMessageId, '缺少消息 ID。')
          if (local) {
            if (mode !== 'queue') throw badRequest('新会话的首条消息需要启动轮次。')
            return json(await submitFirst(fields, parts, signal,
              (thread, write, creationPermission) => sendPrompt(thread.id, fields, parts, signal, { write, creationPermission }),
              (rpc, thread, id) => recoverPrompt(rpc, thread, id, fields.reportQueuedForLater === true)))
          }
          const worktree = fields.worktree === undefined ? undefined : validateWorktreeSelection(fields.worktree)
          if (worktree && (mode !== 'queue' || worktree.id !== clientUserMessageId || fields.unarchive === true)) {
            throw badRequest('工作树会话需要通过新会话的首条消息启动。')
          }
          if (mode === 'steer' && expectedTurnId !== undefined) required(expectedTurnId, '当前轮次 ID 无效。')
          return json(await submit(threadId, async () => {
            const start = worktree && await worktreeStart(threadId, worktree, signal)
            if (start) {
              worktreeRecovery = start.accepted ? { ...start.native, thread: start.accepted.thread } : start.native
              const digest = createHash('sha256').update(JSON.stringify({ parts, planMode })).digest('hex')
              // 提交 ID 绑定上一次可能已送达的正文与附件。原生明确拒绝时仍可编辑后重试。
              if ((start.accepted || start.uncertain) && start.inputDigest !== digest) {
                throw worktreeConflict('worktree-input-changed', '草稿已编辑。请打开目标会话检查原消息，再在其中发送修改后的内容。')
              }
              if (start.accepted) return start.accepted
              start.inputDigest = digest
            }
            const destination = start?.native.thread.id ?? threadId
            const run = () => sendPrompt(destination, fields, parts, signal, {
              recover: start?.uncertain ? rpc => recoverWorktreePrompt(rpc, start.native.thread, clientUserMessageId, signal, fields.reportQueuedForLater === true) : undefined,
              uncertain: start && (() => { start.uncertain = true }),
            })
            if (!start) return run()
            try {
              const result = await submit(destination, run)
              start.accepted = { ...start.native, ...result, thread: { ...start.native.thread, blank: false } }
              return start.accepted
            } finally {
              permissions?.releaseCreation(destination)
            }
          }))
        }
        if (action === 'cancel') {
          required(turnId, '缺少当前轮次 ID。')
          return json(await withCodexReader(socketPath, signal, async rpc => {
            await requireActiveThread(rpc, threadId)
            return rpc('turn/interrupt', { threadId, turnId })
          }))
        }
        const { operation } = fields
        const keepsRunning = operation === 'steer' || operation === 'restore-steer'
        const run = () => {
          signal.throwIfAborted()
          // 原生取走消息之后由 Host 跟到回执，切换视图或取消网页请求不提前关闭连接。
          return withCodexReader(socketPath, keepsRunning ? ownerSignal : signal, rpc => operation === 'start'
            ? startQueued(rpc, threadId, fields, signal, permissions, scheduleTitle, steers, socketPath)
            : queueAction(rpc, threadId, fields, steers, scheduleTitle))
        }
        return json(await (operation !== 'list' ? submit(threadId, run) : run()))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          const { reason, newSessionRecovery } = error.data ?? {}
          const recovery = reason === 'worktree-delivery-unconfirmed' || reason === 'worktree-input-changed'
          return json({ error: error.message, ...(reason && { reason }), ...(recovery && { worktreeRecovery }), ...(newSessionRecovery && { newSessionRecovery }) }, reason ? 409
            : error.code === -32600 || error.code === -32602 ? 400 : 502)
        }
        if (worktreeRecovery) return json({ error: '无法确认工作树消息的投递结果。可重试原消息或打开目标会话检查。', worktreeRecovery }, 503)
        return json({ error: '无法连接 Codex App Server。' }, 503)
      }
    },
  }
}
