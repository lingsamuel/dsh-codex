/** DSH 使用的占位会话 ID。真实 Codex 线程由第一次原生提交返回。 */
export function isLocalSessionId(id) {
  return typeof id === 'string' && /^web-new-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
}
