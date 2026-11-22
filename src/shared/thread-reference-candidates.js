import { encodeThreadReference } from './thread-references.js'

function workspacePath(path, aliases) {
  const value = aliases[path] ?? path
  const windows = /^(?:[a-z]:|[/\\]{2})/iu.test(value)
  const normalized = windows ? value.replaceAll('\\', '/').toLowerCase() : value
  return normalized.replace(/\/+$/u, '')
}

/** 候选匹配实际显示的会话名称。未命名会话沿用目录显示的摘要。 */
export function threadReferenceCandidates(threads, threadId, directory, query, aliases = {}) {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return []
  const workspace = directory && workspacePath(directory, aliases)
  const candidates = []
  for (const thread of threads) {
    if (thread.id === threadId || thread.ephemeral || thread.archived) continue
    const label = [thread.name, thread.preview, thread.id].find(value => typeof value === 'string' && value.trim())?.trim()
    if (!label?.toLocaleLowerCase().includes(term)) continue
    const path = thread.cwd && workspacePath(thread.cwd, aliases)
    const sameWorkspace = Boolean(directory && thread.cwd && (path === workspace || path.startsWith(workspace + '/')))
    candidates.push({ sessionId: thread.id, label, cwd: thread.cwd, sameWorkspace, createdAt: thread.createdAt * 1000,
      mention: encodeThreadReference(thread.id, label) })
  }
  return candidates.sort((left, right) => Number(right.sameWorkspace) - Number(left.sameWorkspace)).slice(0, 50)
}
