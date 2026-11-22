import { resolveWorkspacePaths } from './workspace-paths.mjs'

/** 原生目录事件尽量使用自带对象。只有标识符的事件单独读取受影响的记录。 */
export async function readCatalogEvent(notification, request) {
  const { method, params } = notification
  switch (method) {
    case 'thread/status/changed':
    case 'thread/readState/changed':
      return { type: 'notification', notification }
    case 'thread/deleted':
      return { type: 'thread', id: params.threadId, thread: null }
    case 'thread/started':
    case 'thread/name/updated':
    case 'thread/project/updated':
    case 'thread/section/changed':
    case 'thread/archived':
    case 'thread/unarchived': {
      const { thread, readState } = params.thread ? params : await request('thread/read', { threadId: params.threadId })
      return {
        type: 'thread', id: thread.id, thread: method === 'thread/archived' ? { ...thread, archived: true } : thread, readState,
        workspacePaths: await resolveWorkspacePaths([thread.cwd]),
      }
    }
    case 'project/changed': {
      const id = params.projectId
      if (params.changeType === 'deleted') return { type: 'project', id, project: null }
      const { project } = await request('project/read', { projectId: id })
      return {
        type: 'project', id, project,
        workspacePaths: await resolveWorkspacePaths(project.roots.map(root => root.path)),
      }
    }
  }
}
