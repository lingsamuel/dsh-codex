import { readPage } from './api.js'

export const searchResultLimit = 20

/** Codex 为普通和归档历史提供独立分页，两种来源共用侧栏的结果上限。 */
export async function searchCodexThreads(searchTerm, signal, filter = 'default') {
  const scopes = filter === 'show' ? [false, true] : [filter === 'only']
  const pages = await Promise.all(scopes.map(async archived => {
    const page = await readPage('search', { searchTerm, ...(archived && { archived: 1 }) }, signal)
    return archived ? { ...page, data: page.data.map(item => ({ ...item, thread: { ...item.thread, archived: true } })) } : page
  }))
  const ranked = pages.flatMap(page => page.data)
  if (pages.length > 1) ranked.sort((a, b) => (b.thread.updatedAt ?? 0) - (a.thread.updatedAt ?? 0))
  const unique = new Map()
  for (const item of ranked) if (!unique.has(item.thread.id)) unique.set(item.thread.id, item)
  return {
    data: [...unique.values()].slice(0, searchResultLimit),
    workspacePaths: Object.assign({}, ...pages.map(page => page.workspacePaths)),
    hasMore: unique.size > searchResultLimit || pages.some(page => Boolean(page.nextCursor)),
  }
}
