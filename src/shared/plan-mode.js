export function isPlanMode(mode) {
  return mode === 'default' || mode === 'plan'
}

/** App Server 设置和 rollout 使用不同字段名，模式值由 Codex 定义。 */
export function planModeOf(settings) {
  const mode = (settings?.collaborationMode ?? settings?.collaboration_mode)?.mode
  return isPlanMode(mode) ? mode : undefined
}
