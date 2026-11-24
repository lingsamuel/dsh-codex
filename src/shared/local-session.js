/** DSH 使用的占位会话 ID。真实 Codex 线程由第一次原生提交返回。 */
export function isLocalSessionId(id) {
  return typeof id === 'string' && /^web-new-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
}

/** 首发和草稿终端共用同一份 Git 检出选择。 */
export function worktreeSelection(worktree) {
  if (!worktree) return
  const { kind, id, path, baseRef } = worktree
  return { kind, id, path, baseRef }
}
