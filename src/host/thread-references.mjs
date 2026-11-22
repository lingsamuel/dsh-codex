import { threadReferenceCandidates } from '../shared/thread-reference-candidates.js'

/** 引用候选从 Codex 原生历史查询获得。新草稿仅用工作目录参与排序。 */
export async function readThreadReferenceCandidates(rpc, threadId, cwd, query) {
  const term = query.trim()
  if (!term) return []
  const [titles, selected] = await Promise.all([
    rpc('thread/list', { searchTerm: term, limit: 50, sortKey: 'updated_at', archived: false, modelProviders: [], useStateDbOnly: true }),
    threadId ? rpc('thread/read', { threadId }) : undefined,
  ])
  const directory = selected?.thread.cwd ?? cwd
  return threadReferenceCandidates(titles.data, threadId, directory, term)
}
