import { groupThreads, threadTitle } from '../workspaces.js'
import { pinnedSectionId } from '../../shared/thread-sections.js'
import { subagentAddress, subagentPath } from './subagents.js'
import { readPage } from '../api.js'

const noRetention = {}
const mainRetention = { mainView: 1 }

export function remoteFailure(message) {
  return { code: 'codex/history', message }
}

/** 先把原生线程补入同一个目录，再交给 DSH 打开。 */
export async function openCodexThread(catalog, navigation, threadId, signal) {
  const { threads, childThreads } = catalog.store.getSnapshot()
  if (!childThreads[threadId] && !threads.some(thread => thread.id === threadId)) {
    const { thread } = await readPage('thread-summary', { threadId }, signal)
    if (!thread) throw new Error('原生会话已不可用。')
    catalog.acceptThread(thread)
  }
  signal?.throwIfAborted()
  navigation?.openSession(threadId)
}

function unixMillis(seconds) {
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

function workspaceTimes(group, isProject) {
  let createdAt = Infinity
  let updatedAt = 0
  for (const thread of group.threads) {
    const created = unixMillis(thread.createdAt || thread.updatedAt)
    if (created) createdAt = Math.min(createdAt, created)
    // Codex 读取未保存的草稿时会返回当前时间，不能把它当成对话活动。
    if (isProject || (!thread.archived && !thread.blank)) {
      updatedAt = Math.max(updatedAt, unixMillis(thread.updatedAt))
    }
  }
  return {
    createdAt: new Date(unixMillis(group.createdAt) || (Number.isFinite(createdAt) ? createdAt : 0)).toISOString(),
    updatedAt: new Date(unixMillis(group.updatedAt) || updatedAt).toISOString(),
  }
}

function compareWorkspaces(a, b) {
  const aIsProject = a.workspaceId.startsWith('project:')
  const bIsProject = b.workspaceId.startsWith('project:')
  // 稳定排序保留 Codex 项目顺序，目录 ID 让同一时间的目录排序独立于会话清单。
  if (aIsProject !== bIsProject) return aIsProject ? -1 : 1
  if (aIsProject) return 0
  const recency = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  if (recency) return recency
  if (a.workspaceId === b.workspaceId) return 0
  return a.workspaceId < b.workspaceId ? -1 : 1
}

/** 把 Codex 目录和会话投影成 DSH 客户端列表的内存快照。 */
export function projectCatalog({ projects, threads, selected, workspacePaths, busy, error, childThreads = {}, childCatalogs = {} }) {
  const phase = busy || error ? 'pending' : 'ready'
  const ids = threads.map(thread => thread.id)
  const byId = Object.fromEntries([...threads, ...Object.values(childThreads)].map(thread => {
    // DSH 面包屑沿摘要中的直接父级逐级向上查找。
    const address = subagentAddress(thread)
    const title = (address && subagentPath(thread)) || threadTitle(thread)
    return [thread.id, {
      id: thread.id,
      title,
      displayTitle: title,
      ...(address && { origin: 'subagent', parentId: address.parentSessionId }),
      cwd: thread.cwd || undefined,
      running: thread.status?.type === 'active',
      retainedBy: selected?.id === thread.id ? mainRetention : noRetention,
      blank: Boolean(thread.blank) && thread.status?.type === 'idle',
      updatedAt: unixMillis(thread.updatedAt),
    }]
  }))
  const projectionsBySession = Object.fromEntries(Object.entries(childCatalogs).map(([id, value]) => {
    const subagentCatalog = value.ids.map(childId => {
      const thread = childThreads[childId]
      const label = subagentPath(thread) || thread.agentNickname || thread.agentRole || thread.name
      return { id: childId, label, createdAt: unixMillis(thread.createdAt), mode: subagentAddress(thread)?.mode ?? 'unknown' }
    })
    return [id, { state: value.state, error: value.error, values: { subagentCatalog } }]
  }))
  const items = groupThreads(threads, projects, workspacePaths).flatMap(([key, group]) => {
    const path = group.roots[0]
    if (!path) return []
    return [{
      workspaceId: key,
      path,
      title: group.name,
      sessionIds: group.threads.map(thread => thread.id),
      ...workspaceTimes(group, key.startsWith('project:')),
    }]
  }).sort(compareWorkspaces)
  return {
    sessions: { ids, byId, phase, projectionsBySession },
    workspaces: {
      items,
      archivedSessionIds: threads.filter(thread => thread.archived).map(thread => thread.id),
      pinnedSessionIds: threads.filter(thread => thread.section?.id === pinnedSectionId).map(thread => thread.id),
      phase,
      state: error ? 'error' : busy ? 'loading' : 'idle',
      error: error ? remoteFailure(error) : null,
    },
  }
}

/** 给 DSH 各层返回稳定的 snapshot 引用，以便 React 订阅使用。 */
export function observe(source, project) {
  let previous
  let value
  return {
    subscribe: source.subscribe,
    getSnapshot() {
      const next = source.getSnapshot()
      if (next !== previous) {
        previous = next
        value = project(next)
      }
      return value
    },
  }
}
