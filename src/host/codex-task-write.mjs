import { canonicalThreadId, delegatedPrompt, historyPaginationUnsupported, readTaskTurnPage, taskErrorMessage } from './codex-task-read.mjs'
import { waitForThreadActivity } from './thread-runtime.mjs'

const sandboxModes = new Map([
  ['dangerFullAccess', 'danger-full-access'], ['readOnly', 'read-only'], ['workspaceWrite', 'workspace-write'],
])

function requireTitle(title) {
  if (!title.trim()) throw new Error('title must not be empty')
}

function delegationInput(callerId, prompt) {
  if (!prompt.trim()) throw new Error('prompt must not be empty')
  const wrapped = delegatedPrompt(callerId, prompt)
  if (Buffer.byteLength(prompt) > 1000 || Buffer.byteLength(wrapped) > 1256) {
    throw new Error('prompt exceeded the maximum context budget')
  }
  return wrapped
}

/** 仅在原生协议明确拒绝分页字段时回退，避免网络故障后重做写入。 */
async function withHistoryFallback(request, method, params, field, legacyValue) {
  try {
    return await request(method, params)
  } catch (error) {
    if (params[field] && historyPaginationUnsupported(error)) {
      return request(method, { ...params, [field]: legacyValue })
    }
    throw error
  }
}

function resumeSettings(request, { id, historyMode }, config) {
  return withHistoryFallback(request, 'thread/resume', {
    threadId: id, excludeTurns: historyMode === 'paginated', config,
  }, 'excludeTurns', false)
}

async function startDelegatedTurn(request, threadId, name, output, model, sandboxPolicy, signal) {
  // App Server 将原生委派标记识别为后台任务输入，并将其用于任务摘要。工具输入保留工具权限。
  const { turn } = await request('turn/start', {
    threadId, input: [], toolOutput: { name, namespace: 'codex_tui', output }, model, sandboxPolicy,
  })
  if (turn?.status === 'inProgress') await waitForThreadActivity(request, threadId, signal)
}

/** 以调用者的有效工作区、模型和审批设置创建独立任务，委派内容以原生工具输出启动。 */
export async function createTask(request, { prompt, title, model }, caller, config, signal) {
  const output = delegationInput(caller.threadId, prompt)
  if (title !== undefined) requireTitle(title)
  const { thread: source } = await request('thread/read', { threadId: caller.threadId })
  if (source.ephemeral) throw new Error('ephemeral tasks cannot create inspectable background tasks')
  const effective = await resumeSettings(request, source)
  const { activePermissionProfile, sandbox: sandboxPolicy, serviceTier, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer } = effective
  const permissions = activePermissionProfile?.id
  const sandbox = permissions ? undefined : sandboxModes.get(sandboxPolicy?.type)
  if (!permissions && !sandbox) throw new Error('Cannot inherit the source sandbox without a permission profile')
  const { thread } = await withHistoryFallback(request, 'thread/start', {
    model: model ?? effective.model, modelProvider: source.modelProvider, cwd: source.cwd, projectId: source.projectId ?? undefined,
    ephemeral: false, historyMode: source.historyMode === 'paginated' ? 'paginated' : undefined, config,
    serviceTier, runtimeWorkspaceRoots, approvalPolicy, approvalsReviewer, permissions, sandbox,
  }, 'historyMode', undefined)
  if (title !== undefined) {
    try {
      await request('thread/name/set', { threadId: thread.id, name: title.trim() })
    } catch (error) {
      console.error(`Could not set background task title (${thread.id}): ${taskErrorMessage(error)}`)
    }
  }
  await startDelegatedTurn(request, thread.id, 'create_thread', output, undefined, permissions ? undefined : sandboxPolicy, signal)
  return { threadId: thread.id }
}

/** 原生 fork 的排除边界指向调用者这次工具所在的轮次，其他活跃任务使用当前进行中轮次。 */
export async function forkTask(request, args, caller, config) {
  const threadId = args.threadId ?? caller.threadId
  const { thread } = await request('thread/read', { threadId })
  let beforeTurnId
  if (canonicalThreadId(threadId) === canonicalThreadId(caller.threadId)) {
    beforeTurnId = caller.turnId
    if (!beforeTurnId) throw new Error('missing calling turn metadata for fork_thread')
  } else if (thread.status?.type === 'active') {
    const { data } = await readTaskTurnPage(request, { threadId, limit: 1, itemsView: 'notLoaded' })
    if (data[0]?.status === 'inProgress') beforeTurnId = data[0].id
  }
  const { thread: fork } = await withHistoryFallback(request, 'thread/fork', {
    threadId, beforeTurnId, ephemeral: Boolean(thread.ephemeral), excludeTurns: thread.historyMode === 'paginated', config,
  }, 'excludeTurns', false)
  return { environment: { type: 'same-directory' }, sourceThreadId: threadId, threadId: fork.id,
    continuation: 'The fork contains completed history only. If the source thread was running, the active turn and unfinished response are not in the child. Send a follow-up message to threadId only if the task requires work to continue there.' }
}

/** 目标会话加载后由 App Server 自行决定启动新轮次或接纳到当前轮次。 */
export async function sendToTask(request, { threadId, prompt, model }, caller, config, signal) {
  const output = delegationInput(caller.threadId, prompt)
  const { thread } = await request('thread/read', { threadId })
  // 已加载的空会话尚无 rollout，直接使用当前运行时。检查期间由其他客户端恢复的会话同样如此。
  if (thread.status?.type === 'notLoaded') {
    const { thread: current } = await request('thread/read', { threadId })
    if (current.status?.type === 'notLoaded') await resumeSettings(request, current, config)
  }
  await startDelegatedTurn(request, threadId, 'send_message_to_thread', output, model, undefined, signal)
  return { threadId }
}

export async function renameTask(request, { threadId, title }, caller) {
  requireTitle(title)
  threadId ??= caller.threadId
  await request('thread/name/set', { threadId, name: title })
  return { threadId, title }
}

export async function archiveTask(request, { threadId, archived }, caller) {
  threadId ??= caller.threadId
  if (archived && canonicalThreadId(threadId) === canonicalThreadId(caller.threadId)) {
    throw new Error('cannot archive the calling task')
  }
  await request(archived ? 'thread/archive' : 'thread/unarchive', { threadId })
  return { threadId, archived }
}
