import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { readProjects } from './catalog.mjs'

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
      // 移动项目与更新项目发相同事件。只读项目排序，保留线程列表和当前聊天。
      const projects = await readProjects(request)
      return {
        type: 'projects', projects,
        workspacePaths: await resolveWorkspacePaths(projects.flatMap(project => project.roots.map(root => root.path))),
      }
    }
  }
}
