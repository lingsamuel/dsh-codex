import { installCodexPluginSettings } from './codex-plugin-settings.jsx'
import { installCodexMcpSettings } from './codex-mcp-settings.jsx'

/** 挂载由 Codex 提供数据与操作的设置页面。 */
export function installCodexCapabilities(ctx) {
  installCodexPluginSettings(ctx)
  installCodexMcpSettings(ctx)
}
