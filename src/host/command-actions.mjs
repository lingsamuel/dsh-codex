import { clearTimeout, setTimeout } from 'node:timers'
import { CodexRpcError, openCodexReader, withCodexReader } from './app-server.mjs'
import { readLatestTurn } from './live-history.mjs'
import { addressableThread, isArchived, readConversationQueue, resumeThread, unarchiveForSubmission, waitForThreadActivity } from './thread-runtime.mjs'
import { isPlanMode, planModeOf } from '../shared/plan-mode.js'

const goalActions = new Set(['goal-create', 'goal-pause', 'goal-resume', 'goal-clear'])

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function requiredText(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new CodexRpcError({ code: -32602, message })
  return value.trim()
}

function conflict(message) {
  throw new CodexRpcError({ code: -32600, message })
}

function reviewTarget(target) {
  const { type, branch, sha, instructions } = target ?? {}
  if (type === 'uncommittedChanges') return { type }
  if (type === 'baseBranch') return { type, branch: requiredText(branch, '请输入审查基准分支。') }
  if (type === 'commit') return { type, sha: requiredText(sha, '请输入要审查的提交 ID。'), title: null }
  if (type === 'custom') return { type, instructions: requiredText(instructions, '请输入审查要求。') }
  throw new CodexRpcError({ code: -32602, message: '无效的审查目标。' })
}

/** 浏览计划模式选项只读取 Codex 原生目录。 */
export async function readPlanModes(request) {
  const { data } = await request('collaborationMode/list', {})
  return [...new Set(data.map(({ mode }) => mode).filter(isPlanMode))]
}

async function readCommandThread(request, threadId, unarchive) {
  const thread = await addressableThread(request, threadId, unarchive)
  if (unarchive) return unarchiveForSubmission(request, thread)
  // 冷线程的 thread/read 可以省略归档位，目录才是原生归档状态的依据。
  if (thread.status?.type === 'notLoaded' && await isArchived(request, threadId)) conflict('请先取消归档再执行此命令。')
  return thread
}

async function resumeForCommand(request, thread, onResume) {
  if (thread.status?.type !== 'notLoaded') return thread
  // 冷恢复可能直接领取已有待发项，明确把队列的处理留给发起该操作的用户。
  if ((await readConversationQueue(request, thread.id)).length) conflict('请先处理当前会话的待发队列。')
  return resumeThread(request, thread, onResume)
}

async function startCommandTurn(request, thread, action, target, signal) {
  const threadId = thread.id
  if (!['idle', 'notLoaded'].includes(thread.status?.type)) conflict('请在当前轮次结束后执行此命令。')
  if (action === 'compact' && !(await readLatestTurn(request, threadId, 'notLoaded'))) conflict('此会话还没有可压缩的历史。')
  await resumeForCommand(request, thread)
  // 恢复响应可能先于原生队列或目标调度，开始命令前重新读取运行状态。
  if ((await addressableThread(request, threadId)).status?.type !== 'idle') conflict('请在当前轮次结束后执行此命令。')
  const result = action === 'compact' ? await request('thread/compact/start', { threadId })
    : await request('review/start', { threadId, target })
  await waitForThreadActivity(request, threadId, signal)
  return result
}

function goalUpdate({ action, objective, tokenBudget, expectedGoal }) {
  if (action === 'goal-clear') {
    return { objective: requiredText(expectedGoal?.objective, '请先确认要清除的目标。'), createdAt: expectedGoal.createdAt }
  }
  if (action !== 'goal-create') return { status: action === 'goal-pause' ? 'paused' : 'active' }
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
    throw new CodexRpcError({ code: -32602, message: 'Token 预算必须是正整数。' })
  }
  return { status: 'active', objective: requiredText(objective, '请输入目标内容。'), ...(tokenBudget !== undefined && { tokenBudget }) }
}

async function updateGoal(request, thread, action, update) {
  const threadId = thread.id
  const { goal } = await request('thread/goal/get', { threadId })
  if ((action === 'goal-create' && goal) || (action === 'goal-pause' && goal?.status !== 'active')
    || (action === 'goal-resume' && goal?.status !== 'paused')) conflict('目标状态已变化，请重新查看。')
  if (action === 'goal-clear') {
    if (!goal) return { goal: null }
    // 确认只适用于当时面板上的目标。其他客户端可能已移除并重新创建目标。
    if (goal.objective !== update.objective || (update.createdAt !== undefined && goal.createdAt !== update.createdAt)) {
      conflict('目标已变化，请核对新的目标后重新确认。')
    }
    await request('thread/goal/clear', { threadId, origin: 'user' })
    return { goal: null }
  }
  if (update.status === 'active') await resumeForCommand(request, thread)
  return request('thread/goal/set', { threadId, origin: 'user', ...update })
}

async function selectPlanMode(socketPath, signal, threadId, mode, unarchive, observeDraftSettings) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const confirmed = Promise.withResolvers()
  function confirm(settings) {
    if (planModeOf(settings) === mode) confirmed.resolve(true)
  }
  const connection = await openCodexReader(socketPath, deadline, ({ method, params }) => {
    if (method === 'thread/settings/updated' && params?.threadId === threadId) confirm(params.threadSettings)
  })
  let stop
  let timeout
  try {
    const request = connection.request
    if (!(await readPlanModes(request)).includes(mode)) conflict('Codex 未提供这个协作模式。')
    const thread = await readCommandThread(request, threadId, unarchive)
    let draftSettings
    stop = observeDraftSettings(threadId, settings => {
      draftSettings = settings
      confirm(settings)
    })
    let settings
    let runtime = await resumeForCommand(request, thread, (_, resumed) => { settings = resumed })
    // 已写入历史的热会话可临时加入，获取这次显式设置的原生确认。空白线程仍可提交设置。
    if (!settings && !stop && await readLatestTurn(request, threadId, 'notLoaded')) {
      settings = await request('thread/resume', { threadId, excludeTurns: true })
      runtime = settings.thread
    }
    if (planModeOf(settings ?? draftSettings ?? runtime) === mode) return { mode, confirmed: true }
    const model = settings?.model ?? draftSettings?.model ?? runtime.model
    const effort = settings?.reasoningEffort ?? draftSettings?.effort ?? draftSettings?.reasoningEffort ?? runtime.reasoningEffort ?? null
    await request('thread/settings/update', { threadId, collaborationMode: { mode, settings: {
      model: requiredText(model, 'Codex 尚未提供当前会话的模型。'), reasoning_effort: effort, developer_instructions: null,
    } } })
    // 0.171.0 的设置响应在应用完成后返回。没有可附加连接的空白线程以此确认。
    if (!settings && !stop) return { mode, confirmed: true }
    const changed = await Promise.race([confirmed.promise, connection.closed.then(() => false),
      new Promise(resolve => { timeout = setTimeout(resolve, 5_000, false) })])
    return { mode, confirmed: changed }
  } finally {
    clearTimeout(timeout)
    stop?.()
    connection.close()
  }
}

/** 各命令通过同一个会话提交顺序转成明确的原生操作。 */
export function createCommandActionRoute(socketPath, ownerSignal, submit, observeDraftSettings) {
  return {
    path: '/api/codex/command-action', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      try {
        if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return json({ error: '只接受 JSON 请求。' }, 415)
        }
        const fields = await request.json().catch(() => null)
        const { action, mode, unarchive } = fields ?? {}
        const threadId = requiredText(fields?.threadId, '缺少 Codex 线程 ID。')
        if (action === 'plan') {
          if (!isPlanMode(mode)) return json({ error: '无效的协作模式。' }, 400)
          return json(await submit(threadId, () => selectPlanMode(socketPath, signal, threadId, mode, unarchive === true, observeDraftSettings)))
        }
        if (action === 'goal-unarchive' && unarchive === true) {
          return json(await submit(threadId, () => withCodexReader(socketPath, signal, async rpc => {
            await readCommandThread(rpc, threadId, true)
            return rpc('thread/goal/get', { threadId })
          })))
        }
        const isGoal = goalActions.has(action)
        if (!isGoal && action !== 'compact' && action !== 'review') return json({ error: '无效的命令。' }, 400)
        const input = isGoal ? goalUpdate(fields) : action === 'review' ? reviewTarget(fields.target) : undefined
        return json(await submit(threadId, () => withCodexReader(socketPath, signal, async rpc => {
          const thread = await readCommandThread(rpc, threadId, unarchive === true)
          return isGoal ? updateGoal(rpc, thread, action, input) : startCommandTurn(rpc, thread, action, input, signal)
        })))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          return json({ error: error.message }, error.code === -32602 ? 400 : error.code === -32600 ? 409 : 502)
        }
        return json({ error: '无法连接 Codex App Server。' }, 503)
      }
    },
  }
}
