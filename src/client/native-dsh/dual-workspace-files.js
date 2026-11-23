import { codexFileScopePrefix } from '../../shared/dual-web-entry.js'
import { replaceMethod } from './replace-method.js'

/** 同源的两个入口共用原生文件服务，Codex 页面只给自身的会话请求标明来源。 */
export function installCodexFileScope(ctx) {
  ctx.inject(['remote', 'remote.workspaceFiles'], scope => scope.effect(() => {
    const files = scope.remote.workspaceFiles
    const release = []
    for (const name of ['read', 'readBytes', 'stat', 'list', 'search', 'changes']) {
      const invoke = files[name]
      if (typeof invoke !== 'function') continue
      release.push(replaceMethod(files, name, (sessionId, ...args) => invoke.call(files, codexFileScopePrefix + sessionId, ...args)))
    }
    return () => release.forEach(dispose => dispose())
  }))
}
