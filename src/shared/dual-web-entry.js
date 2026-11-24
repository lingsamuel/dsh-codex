export const codexFileScopePrefix = 'codex:'
export const nativeSessionClient = '@deepseek-ai/dsh-api-session-controller'
export const codexClientReloadEvent = 'dsh-codex:client-reload'

/** 同源的 DSH 与 Codex 页面各自恢复终端的标签绑定和待关闭操作。 */
export function installCodexStorageScope(local, prototype) {
  const terminalPrefixes = ['dsh.terminal.binding.v1.', 'dsh.terminal.close.v1.']
  const prefixes = ['dsh.conversation.', ...terminalPrefixes]
  const codexPrefix = prefix => 'dsh.codex.' + prefix.slice(4)
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    const original = prototype[method]
    prototype[method] = function (key, ...args) {
      if (this !== local || typeof key !== 'string') return original.call(this, key, ...args)
      const prefix = prefixes.find(prefix => key.startsWith(prefix))
      if (prefix) key = codexPrefix(prefix) + key.slice(prefix.length)
      else if (key === 'dsh.sessions.current') key = 'dsh.codex.sessions.current'
      return original.call(this, key, ...args)
    }
  }
  const indexKey = prototype.key
  prototype.key = function (index) {
    const key = indexKey.call(this, index)
    if (this !== local || key === null) return key
    for (const prefix of terminalPrefixes) {
      const codex = codexPrefix(prefix)
      if (key.startsWith(codex)) return prefix + key.slice(codex.length)
      if (key.startsWith(prefix)) return null
    }
    return key
  }
}

export const conflictingClientPackages = new Set([
  nativeSessionClient,
  '@deepseek-ai/dsh-api-job-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-schedule',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-session-log-export',
])

export function selectCodexBoot(graph, excluded = conflictingClientPackages) {
  const retained = new Set(graph.entries.filter(entry => !excluded.has(entry.id)).map(entry => entry.id))
  // 有静态导入的模块仍须由加载器提供，服务依赖则只引用本页启用的条目。
  const entries = graph.entries.filter(entry => retained.has(entry.id)).map(entry => entry.inject
    ? { ...entry, inject: entry.inject.filter(id => retained.has(id)) }
    : entry)
  const batches = graph.batches.map(batch => ({
    ...batch, entries: batch.entries.filter(id => retained.has(id)),
  })).filter(batch => batch.entries.length > 0)
  return { ...graph, entries, batches }
}

/** 在原生客户端装配前接入，启动和热更新都采用当前页面的插件清单。 */
export function installCodexGraphSync(loader, boot, adapterId, selectGraph, requestReload) {
  const adapterRev = boot.entries.find(entry => entry.id === adapterId)?.rev
  const create = loader.create
  let reloadRequested = false

  function reloadPage() {
    if (!reloadRequested) {
      reloadRequested = true
      requestReload()
    }
    return Promise.resolve()
  }

  loader.create = function (...args) {
    const modules = create.apply(this, args)
    const { entries } = modules
    const sync = entries.sync.bind(entries)
    const reload = entries.reload.bind(entries)
    entries.sync = graph => {
      // 由 DSH 自己识别 Host 版本变化及未知格式，避免用旧页的装配规则解释新版本。
      if (graph?.release?.version !== boot.release?.version || graph?.release?.commit !== boot.release?.commit
        || !Array.isArray(graph?.entries) || !Array.isArray(graph.batches)) return sync(graph)
      // 会话视图仍持有 Codex adapter。先刷新文档才能完整释放旧绑定及对应的视图。
      if (graph.entries.find(entry => entry?.id === adapterId)?.rev !== adapterRev) return reloadPage()
      return sync(selectGraph(graph))
    }
    entries.reload = (id, rev) => id === adapterId && rev !== adapterRev ? reloadPage() : reload(id, rev)
    return modules
  }
}
