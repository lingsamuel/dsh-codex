import { codexFileScopePrefix } from '../../shared/dual-web-entry.js'
import { isLocalSessionId } from '../../shared/local-session.js'
import { replaceMethod } from './replace-method.js'

/** 复用原生文件服务。双入口标记 Codex 来源，网页草稿另外携带已选目录。 */
export function installCodexFileScope(ctx, sharedWeb = true) {
  const prefix = sharedWeb ? codexFileScopePrefix : ''
  ctx.inject(['remote', 'remote.workspaceFiles', 'sessions'], scope => scope.effect(() => {
    const files = scope.remote.workspaceFiles
    const release = []
    for (const name of ['read', 'readBytes', 'stat', 'list', 'search', 'changes']) {
      const invoke = files[name]
      if (typeof invoke !== 'function') continue
      release.push(replaceMethod(files, name, (sessionId, ...args) => {
        const cwd = isLocalSessionId(sessionId) ? scope.sessions.list.getSnapshot().byId[sessionId]?.cwd : undefined
        const id = cwd ? `${sessionId}:${cwd}` : sessionId
        return invoke.call(files, prefix + id, ...args)
      }))
    }
    return () => release.forEach(dispose => dispose())
  }))
}
