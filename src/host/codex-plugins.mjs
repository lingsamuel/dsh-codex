import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { pluginCanToggle } from '../shared/codex-plugin-source.js'
import { readCodex, readCodexPages, withCodexReader } from './app-server.mjs'
import { createCodexCapabilityRoute, invalidCapabilityRequest, requiredValue } from './codex-capability-route.mjs'

function pluginSource({ pluginName, marketplacePath, remoteMarketplaceName }) {
  if (!requiredValue(pluginName) || (marketplacePath && remoteMarketplaceName)
    || (marketplacePath ? typeof marketplacePath !== 'string' || !isAbsolute(marketplacePath) : !requiredValue(remoteMarketplaceName))) {
    throw invalidCapabilityRequest('请选择有效的 Codex 插件和目录。')
  }
  return { pluginName, ...(marketplacePath ? { marketplacePath } : { remoteMarketplaceName }) }
}

function catalogSummaries({ marketplaces, marketplaceLoadErrors }) {
  return { marketplaceLoadErrors, marketplaces: marketplaces.map(({ name, path, interface: market, plugins }) => ({
    name, path, interface: market,
    plugins: plugins.map(({ id, name, installed, enabled, availability, installPolicy, keywords,
      source, remotePluginId, shareContext, interface: info }) => ({
      id, name, installed, enabled, availability, installPolicy, keywords, remotePluginId,
      source: source && { type: source.type },
      shareContext: shareContext && { remotePluginId: shareContext.remotePluginId },
      interface: info && { displayName: info.displayName, shortDescription: info.shortDescription },
    })),
  })) }
}

/** 插件目录、安装状态和 App 可用性均以同一 Codex daemon 的结果为准。 */
export function createCodexPluginRoutes(socketPath, ownerSignal) {
  const list = async ({ cwd, fresh, part }, signal) => {
    if (cwd && !isAbsolute(cwd)) throw invalidCapabilityRequest('Codex 插件目录需要绝对工作目录。')
    const scope = cwd ? { cwds: [cwd] } : {}
    return withCodexReader(socketPath, signal, async request => {
      const [catalog, installed] = await Promise.all([
        part !== 'installed' && request('plugin/list', { ...scope, ...(fresh === '1' && { forceRefetch: true }) }),
        part !== 'catalog' && request('plugin/installed', scope),
      ])
      // 目录可包含上万条记录，资源地址和原生包元数据等到打开详情时再取。
      return { ...(catalog && { catalog: catalogSummaries(catalog) }), ...(installed && { installed }) }
    })
  }
  const detail = (params, signal) => readCodex('plugin/read', pluginSource(params), socketPath, signal)
  const appStates = ({ appIds, threadId, fresh }, signal) => {
    let ids
    try { ids = JSON.parse(appIds) } catch {}
    if (!Array.isArray(ids) || !ids.every(requiredValue)) throw invalidCapabilityRequest('请选择有效的 Codex App。')
    const selected = new Set(ids)
    return withCodexReader(socketPath, signal, async request => {
      const apps = await readCodexPages(cursor => request('app/list', {
        cursor, threadId: threadId || undefined, ...(fresh === '1' && !cursor && { forceRefetch: true }),
      }))
      return { appStates: apps.filter(app => selected.has(app.id)) }
    })
  }
  const change = (params, signal) => {
    if (params.action === 'install') {
      return readCodex('plugin/install', { ...pluginSource(params), installAttemptId: randomUUID() }, socketPath, signal)
    }
    if (params.action === 'uninstall' && requiredValue(params.pluginId)) {
      return readCodex('plugin/uninstall', { pluginId: params.pluginId }, socketPath, signal)
    }
    if (params.action === 'enable' || params.action === 'disable') {
      const source = pluginSource(params)
      return withCodexReader(socketPath, signal, async request => {
        const { plugin } = await request('plugin/read', source)
        const summary = plugin?.summary
        if (!pluginCanToggle(summary)) throw invalidCapabilityRequest('该插件当前无法启用或停用。')
        // 配置使用安装 ID，且必须把含点的插件名作为同一个配置键。
        return request('config/value/write', {
          keyPath: `plugins.${JSON.stringify(summary.id)}`,
          value: { enabled: params.action === 'enable' }, mergeStrategy: 'upsert',
        })
      })
    }
    throw invalidCapabilityRequest('Codex 插件操作无效。')
  }
  return [createCodexCapabilityRoute('plugins', ownerSignal, list, change),
    createCodexCapabilityRoute('plugin', ownerSignal, detail),
    createCodexCapabilityRoute('plugin-apps', ownerSignal, appStates)]
}
