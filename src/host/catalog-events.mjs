import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { readProjects } from './catalog.mjs'
import { CodexRpcError } from './app-server.mjs'

async function summarize({ thread, readState }) {
  return { thread, readState, workspacePaths: await resolveWorkspacePaths([thread.cwd]) }
}

/** 原生目录事件尽量使用自带对象。只有标识符的事件单独读取受影响的记录。 */
export async function readCatalogEvent(notification, request) {
  const { method, params } = notification
  switch (method) {
    case 'thread/status/changed': {
      const update = { type: 'notification', notification }
      if (params.status.type !== 'idle') return update
      try {
        // 首条用户消息保存后，摘要才有 Codex 原生预览。普通状态广播不带这一字段。
        return { ...update, ...await summarize(await request('thread/read', { threadId: params.threadId })) }
      } catch (error) {
        if (error instanceof CodexRpcError) return update
        throw error
      }
    }
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
      const details = await summarize(params.thread ? params : await request('thread/read', { threadId: params.threadId }))
      if (method === 'thread/archived') details.thread = { ...details.thread, archived: true }
      return { type: 'thread', id: details.thread.id, ...details }
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
