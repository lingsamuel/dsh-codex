import { groupThreads, threadTitle } from '../workspaces.js'

const emptyIds = []
const emptyProjections = {}
const noRetention = {}
const mainRetention = { mainView: 1 }

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
export function projectCatalog({ projects, threads, selected, workspacePaths, busy, error }) {
  const phase = busy || error ? 'pending' : 'ready'
  const ids = threads.map(thread => thread.id)
  const byId = Object.fromEntries(threads.map(thread => {
    const title = threadTitle(thread)
    return [thread.id, {
      id: thread.id,
      title,
      displayTitle: title,
      cwd: thread.cwd || undefined,
      running: thread.status?.type === 'active',
      retainedBy: selected?.id === thread.id ? mainRetention : noRetention,
      blank: false,
      updatedAt: unixMillis(thread.updatedAt),
    }]
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
    sessions: { ids, byId, phase, projectionsBySession: emptyProjections },
    workspaces: {
      items,
      archivedSessionIds: emptyIds,
      pinnedSessionIds: emptyIds,
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
