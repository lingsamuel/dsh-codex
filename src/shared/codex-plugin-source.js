const remotePluginId = plugin => plugin.shareContext?.remotePluginId ?? plugin.remotePluginId

/** 原生远程目录使用后端插件 ID，仓库目录按插件名和目录路径定位。 */
export function pluginRequestSource({ path, name }, plugin) {
  const remoteId = remotePluginId(plugin)
  const pluginName = plugin.source?.type === 'remote' ? (remoteId ?? plugin.name) : plugin.name
  if (path) return { pluginName, marketplacePath: path }
  if (remoteId) return { pluginName, remoteMarketplaceName: name }
}

/** 卸载远程插件使用同一个后端标识。本地插件使用 Codex 的安装 ID。 */
export function pluginUninstallId(plugin) {
  return plugin.source?.type === 'remote' ? remotePluginId(plugin) : plugin.id
}
