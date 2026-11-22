/** 旧会话可能只在原生 source 中保存父线程。 */
export function subagentParentThreadId(thread) {
  return thread?.parentThreadId ?? thread?.source?.subAgent?.thread_spawn?.parent_thread_id
}
