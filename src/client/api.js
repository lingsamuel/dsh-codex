async function fetchResult(url, options) {
  const response = await fetch(url, options)
  if (response.status === 401) throw new Error('网页访问已过期，请从 DSH 的启动链接重新打开。')
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error), {
    status: response.status, readState: result.readState, reason: result.reason, activity: result.activity,
    worktreeRecovery: result.worktreeRecovery, newSessionRecovery: result.newSessionRecovery,
  })
  return result
}

export function readPage(collection, parameters, signal) {
  const url = new URL(`api/codex/${collection}`, document.baseURI)
  url.search = new URLSearchParams(parameters).toString()
  return fetchResult(url, { signal })
}

export function requestSessionMarkdown(threadId, signal) {
  const url = new URL('api/codex/session-export', document.baseURI)
  url.searchParams.set('threadId', threadId)
  return fetch(url, { signal })
}

export async function readSessionMarkdown(threadId, signal) {
  const response = await requestSessionMarkdown(threadId, signal)
  if (response.status === 401) throw new Error('网页访问已过期，请从 DSH 的启动链接重新打开。')
  const markdown = await response.text()
  if (!response.ok) throw new Error(markdown || '无法导出 Codex 会话。')
  return markdown
}

/** 通过 DSH 同源入口提交明确的会话管理动作。 */
export function writeThreadAction(parameters, signal) {
  return writeAction('thread-action', parameters, signal)
}

export function writeCommandAction(parameters, signal) {
  return writeAction('command-action', parameters, signal)
}

export function writeWorktreeAction(parameters, signal) {
  return writeAction('worktree-action', parameters, signal)
}

export function writeProjectAction(parameters, signal) {
  return writeAction('project-action', parameters, signal)
}

/** 发送、继续、停止和队列操作沿用项目已有的同源传输。 */
export function writeConversationAction(parameters, signal) {
  if (parameters.action === 'prompt') {
    return writeWithConfirmation('conversation-action', parameters, signal,
      '等待发送确认超时。请查看会话和待发队列确认消息是否送达。')
  }
  if (parameters.action === 'queue' && ['steer', 'restore-steer'].includes(parameters.operation)) {
    return writeWithConfirmation('conversation-action', parameters, signal,
      '等待待发消息确认超时。请查看队列中的投递状态。')
  }
  return writeAction('conversation-action', parameters, signal)
}

/** 使用正在等待的原生请求标识提交答案。 */
export function writeQuestionAnswer(parameters, signal) {
  return writeAnswer('question-answer', parameters, signal)
}

export function writeApprovalDecision(parameters, signal) {
  return writeAction('approval-decision', parameters, signal)
}

export function writeMcpElicitation(parameters, signal) {
  return writeAction('mcp-elicitation', parameters, signal)
}

export function writeCodexCapability(collection, parameters, signal) {
  return writeAction(collection, parameters, signal)
}

export function writePermissionAction(parameters, signal) {
  return writeAction('permission-action', parameters, signal)
}

export const modelDefaultChanged = 'dsh-codex-model-default-changed'

export function writeModelDefault(selection, signal) {
  return writeAction('model-default', { selection }, signal)
}

/** 异步答复优先通过 Codex 原生输入送进提问所在的轮次。 */
export function writeAsyncQuestionAnswer(parameters, signal) {
  return writeAnswer('async-question-answer', parameters, signal)
}

function writeAnswer(route, parameters, signal) {
  return writeWithConfirmation(route, parameters, signal, '等待答复确认超时。请查看会话和待发队列确认答案是否送达。')
}

async function writeWithConfirmation(route, parameters, signal, timeoutMessage) {
  const deadline = AbortSignal.timeout(25_000)
  try {
    return await writeAction(route, parameters, signal ? AbortSignal.any([signal, deadline]) : deadline)
  } catch (error) {
    if (error === deadline.reason) {
      throw new Error(timeoutMessage, { cause: error })
    }
    throw error
  }
}

function writeAction(route, parameters, signal) {
  const url = new URL(`api/codex/${route}`, document.baseURI)
  return fetchResult(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters), signal,
  })
}

export function directoryTitle(directory) {
  return directory.split(/[/\\]/).filter(Boolean).at(-1) || directory
}
