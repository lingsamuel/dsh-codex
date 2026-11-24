import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { isLocalSessionId } from '../shared/local-session.js'

/** 草稿文件请求和路径补全均使用 Host 上已存在的绝对目录。 */
export async function isWorkspaceDirectory(cwd) {
  return isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory() === true
}

/** 网页草稿的目录随文件请求传入，原生会话的目录由 Codex 提供。 */
export async function resolveWorkspaceFileScope(id, readWorkspace) {
  const separator = id.indexOf(':')
  const sessionId = separator < 0 ? id : id.slice(0, separator)
  if (!isLocalSessionId(sessionId)) return { sessionId: id, workspaceRoot: await readWorkspace(id) }
  const cwd = separator < 0 ? '' : id.slice(separator + 1)
  if (await isWorkspaceDirectory(cwd)) return { sessionId, workspaceRoot: cwd }
}

/** 只有文件系统能证明是同一目录时，才折叠大小写不同的原生工作目录。 */
export async function resolveWorkspacePaths(paths) {
  const children = new Map()
  const spellings = new Map()
  function directoryNames(path) {
    if (!children.has(path)) children.set(path, readdir(path).catch(() => []))
    return children.get(path)
  }

  function actualSpelling(path) {
    const parent = dirname(path)
    if (parent === path) return Promise.resolve(path)
    if (!spellings.has(path)) {
      spellings.set(path, actualSpelling(parent).then(async actualParent => {
        const name = basename(path)
        const entries = await directoryNames(actualParent)
        if (entries.includes(name)) return join(actualParent, name)
        const matches = entries.filter(entry => entry.toLowerCase() === name.toLowerCase())
        return join(actualParent, matches.length === 1 ? matches[0] : name)
      }))
    }
    return spellings.get(path)
  }

  const resolved = await Promise.all([...new Set(paths)].map(async cwd => {
    if (!cwd || !isAbsolute(cwd)) return null
    try {
      const [resolvedPath, identity] = await Promise.all([realpath(cwd), stat(cwd, { bigint: true })])
      if (!identity.isDirectory()) return null
      const path = normalize(resolvedPath).toLowerCase() === normalize(cwd).toLowerCase() ? resolvedPath : cwd
      // WSL 对 Windows 挂载目录的 realpath 可能沿用查询的大小写，从实际目录项读回名称。
      const display = await actualSpelling(path)
      return { cwd, display, identity }
    } catch {
      return null
    }
  }))

  const representatives = new Map()
  const aliases = []
  for (const result of resolved) {
    if (!result) continue
    const { cwd, display, identity } = result
    const key = identity.ino === 0n
      ? cwd
      : `${identity.dev}:${identity.ino}:${normalize(cwd).toLowerCase()}`
    if (!representatives.has(key)) representatives.set(key, display)
    const representative = representatives.get(key)
    if (representative !== cwd) aliases.push([cwd, representative])
  }
  return Object.fromEntries(aliases)
}
