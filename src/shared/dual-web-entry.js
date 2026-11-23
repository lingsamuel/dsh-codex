export const codexFileScopePrefix = 'codex:'
export const nativeConversationPrefix = 'dsh.conversation.'
export const codexConversationPrefix = 'dsh.codex.conversation.'
export const nativeSessionClient = '@deepseek-ai/dsh-api-session-controller'

const conflictingClientPackages = new Set([
  nativeSessionClient,
  '@deepseek-ai/dsh-api-job-controller',
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-schedule',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-session-log-export',
])

export function selectCodexBoot(graph) {
  const retained = new Set(graph.entries.filter(entry => !conflictingClientPackages.has(entry.id)).map(entry => entry.id))
  // 有静态导入的模块仍须由加载器提供，服务依赖则只引用本页启用的条目。
  const entries = graph.entries.filter(entry => retained.has(entry.id)).map(entry => entry.inject
    ? { ...entry, inject: entry.inject.filter(id => retained.has(id)) }
    : entry)
  const batches = graph.batches.map(batch => ({
    ...batch, entries: batch.entries.filter(id => retained.has(id)),
  })).filter(batch => batch.entries.length > 0)
  return { ...graph, entries, batches }
}
