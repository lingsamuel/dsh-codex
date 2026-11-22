import { createHistoryRoutes } from './history.mjs'
import { readCodex } from './app-server.mjs'
import { createVisualizeRoute, visualizeMaxBytes } from './visualize-preview.mjs'
import { createFileReferenceRoute } from './file-references.mjs'

export const name = 'dsh-chatgpt'
export const inject = ['connection', 'loader']

export async function apply(ctx) {
  const owner = new AbortController()
  ctx.effect(() => () => owner.abort())
  // DSH 文件服务的冷读查询只需要 cwd。直接从 Codex 读取该字段，不实例化 DSH 会话。
  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('sessionPersistence', {
    async stat(threadId) {
      const { thread } = await readCodex('thread/read', { threadId }, process.env.DSH_CHATGPT_SOCKET, owner.signal)
      return { header: { cwd: thread.cwd } }
    },
  })
  ctx.provide('sandboxPolicy', { workspaceRoot: process.cwd() })
  for (const route of createHistoryRoutes(undefined, owner.signal, process.env.DSH_CHATGPT_CACHE_DIR)) {
    ctx.effect(() => ctx.connection.fetch.register(route))
  }
  const { WorkspaceFileSearch, DEFAULT_FILE_SEARCH_MAX_RESULTS, DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES } = await import('../../dist/file-reference-search.mjs')
  const searchConfig = { maxResults: DEFAULT_FILE_SEARCH_MAX_RESULTS, maxEntries: DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES }
  ctx.inject(['workspaceFiles', 'typert'], scope => {
    const readFileScope = threadId => scope.typert.lookups.get('workspaceFileScope')?.resolve(threadId)
    const references = createFileReferenceRoute(readFileScope, cwd => new WorkspaceFileSearch(cwd, searchConfig), owner.signal)
    const preview = createVisualizeRoute(async (threadId, path, signal) => {
      const files = await readFileScope(threadId)
      if (!files) throw new Error('找不到 Visualize 引用的工作区。')
      const { data } = await scope.workspaceFiles.readBytes(files, path, {
        range: { offset: 0, length: visualizeMaxBytes + 1 },
      }, signal)
      return data
    })
    scope.effect(() => scope.connection.fetch.register(preview))
    scope.effect(() => scope.connection.fetch.register(references))
  })
  // 仅复用 DSH 的目录选择入口。工作区列表和持久化仍由 Codex 提供。
  const { DirectoryPickerController } = await ctx.loader.import('@deepseek-ai/dsh-api-workspace-controller')
  ctx.plugin(DirectoryPickerController)
}
