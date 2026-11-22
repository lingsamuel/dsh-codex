import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CodexRpcError, readCodex, readCodexPages, withCodexReader } from './app-server.mjs'
import { createCodexCapabilityRoute, invalidCapabilityRequest, requiredValue } from './codex-capability-route.mjs'

function pluginSource({ pluginName, marketplacePath, remoteMarketplaceName }) {
  if (!requiredValue(pluginName) || (marketplacePath && remoteMarketplaceName)
    || (marketplacePath ? typeof marketplacePath !== 'string' || !isAbsolute(marketplacePath) : !requiredValue(remoteMarketplaceName))) {
    throw invalidCapabilityRequest('请选择有效的 Codex 插件和目录。')
  }
  return { pluginName, ...(marketplacePath ? { marketplacePath } : { remoteMarketplaceName }) }
}

/** 插件目录、安装状态和 App 可用性均以同一 Codex daemon 的结果为准。 */
export function createCodexPluginRoutes(socketPath, ownerSignal) {
  const list = async ({ cwd, fresh }, signal) => {
    if (cwd && !isAbsolute(cwd)) throw invalidCapabilityRequest('Codex 插件目录需要绝对工作目录。')
    const scope = cwd ? { cwds: [cwd] } : {}
    return withCodexReader(socketPath, signal, async request => {
      const [catalog, installed] = await Promise.all([
        request('plugin/list', { ...scope, ...(fresh === '1' && { forceRefetch: true }) }),
        request('plugin/installed', scope),
      ])
      return { catalog, installed }
    })
  }
  const detail = (params, signal) => withCodexReader(socketPath, signal, async request => {
    const { plugin } = await request('plugin/read', pluginSource(params))
    if (!plugin.apps?.length) return { plugin, appStates: [] }
    const appIds = new Set(plugin.apps.map(app => app.id))
    try {
      const apps = await readCodexPages(cursor => request('app/list', {
        cursor, threadId: params.threadId || undefined, ...(params.fresh === '1' && !cursor && { forceRefetch: true }),
      }))
      // 只把所选插件相关的原生 App 状态返回页面。
      return { plugin, appStates: apps.filter(app => appIds.has(app.id)) }
    } catch (error) {
      return { plugin, appStates: [], appError: error instanceof CodexRpcError ? error.message : '无法读取 Codex App 授权状态。' }
    }
  })
  const change = (params, signal) => {
    if (params.action === 'install') {
      return readCodex('plugin/install', { ...pluginSource(params), installAttemptId: randomUUID() }, socketPath, signal)
    }
    if (params.action === 'uninstall' && requiredValue(params.pluginId)) {
      return readCodex('plugin/uninstall', { pluginId: params.pluginId }, socketPath, signal)
    }
    throw invalidCapabilityRequest('Codex 插件操作无效。')
  }
  return [createCodexCapabilityRoute('plugins', ownerSignal, list, change),
    createCodexCapabilityRoute('plugin', ownerSignal, detail)]
}
