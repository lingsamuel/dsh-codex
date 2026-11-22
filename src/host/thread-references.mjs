import { isAbsolute, relative, sep } from 'node:path'
import { encodeThreadReference } from '../shared/thread-references.js'
import { resolveWorkspacePaths } from './workspace-paths.mjs'

function titleOf(thread) {
  return [thread.name, thread.preview, thread.id].find(value => typeof value === 'string' && value.trim()).trim()
}

/** 引用候选从 Codex 原生历史查询获得。新草稿仅用工作目录参与排序。 */
export async function readThreadReferenceCandidates(rpc, threadId, cwd, query) {
  if (!query.trim()) return []
  const term = query.trim()
  const lowerTerm = term.toLocaleLowerCase()
  const [search, recent, selected] = await Promise.all([
    rpc('thread/search', { searchTerm: term, limit: 50, archived: false }),
    rpc('thread/list', { limit: 50, sortKey: 'updated_at', archived: false, modelProviders: [] }),
    threadId ? rpc('thread/read', { threadId }) : undefined,
  ])
  const threads = new Map(search.data.map(({ thread }) => [thread.id, thread]))
  for (const thread of recent.data) {
    if (!threads.has(thread.id) && titleOf(thread).toLocaleLowerCase().includes(lowerTerm)) threads.set(thread.id, thread)
  }
  const candidates = [...threads.values()].filter(thread => thread.id !== threadId && !thread.ephemeral && !thread.archived)
  const directory = selected?.thread.cwd ?? cwd
  const paths = await resolveWorkspacePaths([directory, ...candidates.map(thread => thread.cwd)].filter(Boolean))
  const workspace = paths[directory] ?? directory
  return candidates.map(thread => {
    const label = titleOf(thread)
    const path = paths[thread.cwd] ?? thread.cwd
    const location = workspace && path ? relative(workspace, path) : undefined
    const sameWorkspace = location !== undefined && !isAbsolute(location) && location !== '..' && !location.startsWith('..' + sep)
    return { sessionId: thread.id, label, cwd: thread.cwd, sameWorkspace, createdAt: thread.createdAt * 1000,
      mention: encodeThreadReference(thread.id, label) }
  }).sort((left, right) => Number(right.sameWorkspace) - Number(left.sameWorkspace)).slice(0, 50)
}
