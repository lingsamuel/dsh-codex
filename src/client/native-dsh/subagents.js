import { subagentParentThreadId } from '../../shared/codex-subagents.js'

/** 用原生父子线程 ID 构造 DSH 导航地址，并沿用 CLI 的旧版输入能力判断。 */
export function subagentAddress(thread, canAcceptDirectInput = thread?.canAcceptDirectInput) {
  const parentSessionId = subagentParentThreadId(thread)
  if (!parentSessionId) return undefined
  const continuable = canAcceptDirectInput ?? (subagentPath(thread) == null)
  return { parentSessionId, childSessionId: thread.id, mode: continuable ? 'continuable' : 'unknown' }
}

/** 路径是原生线程的当前显示名，历史事件使用各自记录的路径。 */
export function subagentPath(thread) {
  return thread.source?.subAgent?.thread_spawn?.agent_path
}
