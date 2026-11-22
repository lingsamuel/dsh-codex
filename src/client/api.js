async function fetchResult(url, options) {
  const response = await fetch(url, options)
  if (response.status === 401) throw new Error('网页访问已过期，请从 DSH 的启动链接重新打开。')
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error), {
    status: response.status, readState: result.readState, reason: result.reason, activity: result.activity,
  })
  return result
}

export function readPage(collection, parameters, signal) {
  const url = new URL(`api/codex/${collection}`, document.baseURI)
  url.search = new URLSearchParams(parameters).toString()
  return fetchResult(url, { signal })
}

/** 通过 DSH 同源入口提交明确的会话管理动作。 */
export function writeThreadAction(parameters, signal) {
  return writeAction('thread-action', parameters, signal)
}

/** 发送、继续、停止和队列操作沿用项目已有的同源传输。 */
export function writeConversationAction(parameters, signal) {
  return writeAction('conversation-action', parameters, signal)
}

/** 使用正在等待的原生请求标识提交答案。 */
export function writeQuestionAnswer(parameters, signal) {
  return writeAction('question-answer', parameters, signal)
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
