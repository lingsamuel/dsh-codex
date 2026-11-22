import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { readProjectSnapshot, withBlankDraft } from './catalog.mjs'
import { CodexRpcError } from './app-server.mjs'

async function summarize({ thread, readState }) {
  return { thread: withBlankDraft(thread), readState, workspacePaths: await resolveWorkspacePaths([thread.cwd]) }
}

/** 原生目录事件尽量使用自带对象。只有标识符的事件单独读取受影响的记录。 */
export async function readCatalogEvent(notification, request) {
  const { method, params } = notification
  switch (method) {
    case 'thread/status/changed': {
      const update = { type: 'notification', notification }
      const status = params.status.type
      const unloaded = status === 'notLoaded'
      if (!unloaded && status !== 'idle' && status !== 'active') return update
      try {
        // 子代理可能只有状态通知，且初次空闲时摘要还不可读。运行后读回父子关系。
        return { ...update, ...await summarize(await request('thread/read', { threadId: params.threadId })) }
      } catch (error) {
        if (error instanceof CodexRpcError) {
          if (!unloaded) return update
          // 卸载的空白草稿可能没有原生记录。
          if (error.code === -32600 && error.message === `thread not loaded: ${params.threadId}`) {
            return { type: 'thread', id: params.threadId, thread: null }
          }
        }
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
    case 'thread/settings/updated':
    case 'thread/section/changed':
    case 'thread/archived':
    case 'thread/unarchived': {
      const details = await summarize(params.thread ? params : await request('thread/read', { threadId: params.threadId }))
      if (method === 'thread/archived' || method === 'thread/unarchived') {
        details.thread = { ...details.thread, archived: method === 'thread/archived' }
      }
      return { type: 'thread', id: details.thread.id, ...details }
    }
    case 'project/changed':
      // 移动项目与更新项目发相同事件。只读项目排序，保留线程列表和当前聊天。
      return { type: 'projects', ...await readProjectSnapshot(request) }
  }
}
