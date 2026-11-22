/** 旧会话可能只在原生 source 中保存父线程。 */
export function subagentAddress(thread) {
  const parentSessionId = thread?.parentThreadId ?? thread?.source?.subAgent?.thread_spawn?.parent_thread_id
  if (!parentSessionId) return undefined
  return { parentSessionId, childSessionId: thread.id, mode: 'unknown' }
}
