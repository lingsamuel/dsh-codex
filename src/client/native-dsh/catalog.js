import { groupThreads, threadTitle } from '../workspaces.js'
import { subagentAddress } from './subagents.js'

const noRetention = {}
const mainRetention = { mainView: 1 }
// Codex 的内置 Pinned 分组使用固定身份。自建同名分组不等同于置顶。
const pinnedSectionId = '01984de2-8f74-7c91-a3b2-5c5e937cf318'

export function remoteFailure(message) {
  return { code: 'codex/history', message }
}

function unixMillis(seconds) {
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

function workspaceTimes(group) {
  let createdAt = Infinity
  let updatedAt = 0
  for (const thread of group.threads) {
    const created = unixMillis(thread.createdAt || thread.updatedAt)
    if (created) createdAt = Math.min(createdAt, created)
    updatedAt = Math.max(updatedAt, unixMillis(thread.updatedAt))
  }
  return {
    createdAt: new Date(unixMillis(group.createdAt) || (Number.isFinite(createdAt) ? createdAt : 0)).toISOString(),
    updatedAt: new Date(unixMillis(group.updatedAt) || updatedAt).toISOString(),
  }
}

/** 把 Codex 目录和会话投影成 DSH 客户端列表的内存快照。 */
export function projectCatalog({ projects, threads, selected, workspacePaths, busy, error, childThreads = {}, childCatalogs = {} }) {
  const phase = busy || error ? 'pending' : 'ready'
  const ids = threads.map(thread => thread.id)
  const byId = Object.fromEntries([...threads, ...Object.values(childThreads)].map(thread => {
    const title = threadTitle(thread)
    // DSH 面包屑沿摘要中的直接父级逐级向上查找。
    const address = subagentAddress(thread)
    return [thread.id, {
      id: thread.id,
      title,
      displayTitle: title,
      ...(address && { origin: 'subagent', parentId: address.parentSessionId }),
      cwd: thread.cwd || undefined,
      running: thread.status?.type === 'active',
      retainedBy: selected?.id === thread.id ? mainRetention : noRetention,
      blank: false,
      updatedAt: unixMillis(thread.updatedAt),
    }]
  }))
  const projectionsBySession = Object.fromEntries(Object.entries(childCatalogs).map(([id, value]) => {
    const subagentCatalog = value.ids.map(childId => {
      const thread = childThreads[childId]
      return { id: childId, label: thread.agentNickname || thread.agentRole || thread.name, createdAt: unixMillis(thread.createdAt), mode: 'unknown' }
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
      ...workspaceTimes(group),
    }]
  })
  return {
    sessions: { ids, byId, phase, projectionsBySession },
    workspaces: {
      items,
      archivedSessionIds: threads.filter(thread => thread.archived).map(thread => thread.id),
      pinnedSessionIds: threads.filter(thread => !thread.archived && thread.section?.id === pinnedSectionId).map(thread => thread.id),
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
