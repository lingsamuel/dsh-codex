/** Visualize 引用使用生成片段的执行端绝对路径。 */
export function isVisualizePath(path) {
  return typeof path === 'string' && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) && !path.includes('\0')
}
