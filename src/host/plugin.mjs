import { join } from 'node:path'
import { createHistoryRoutes } from './history.mjs'
import { readCodex } from './app-server.mjs'
import { createVisualizeRoute, visualizeMaxBytes } from './visualize-preview.mjs'
import { createFileReferenceRoute } from './file-references.mjs'
import { createSessionExportRoute } from './session-export.mjs'
import { installDualWebEntry } from './dual-web-entry.mjs'
import { createWebModeRoute, openWebModes } from './web-mode.mjs'
import { codexFileScopePrefix } from '../shared/dual-web-entry.js'
import { webModeFor } from '../shared/web-mode.js'

export const name = 'dsh-chatgpt'
export const inject = ['connection', 'loader', 'attachments']

export async function apply(ctx, { sharedWeb = false } = {}) {
  const owner = new AbortController()
  const profile = ctx.get('profileContext')
  const cacheDirectory = process.env.DSH_CHATGPT_CACHE_DIR ?? (profile && join(profile.dir, 'dsh-chatgpt'))
  ctx.effect(() => () => owner.abort())
  const loadSessionMedia = async () => {
    const [{ createSessionMediaReferences }, fileSystem] = await Promise.all([
      import('../../dist/session-media-references.mjs'),
      ctx.loader.import('@deepseek-ai/dsh-fs'),
    ])
    return createSessionMediaReferences(fileSystem)
  }
  const state = sharedWeb && await openWebModes(profile)
  if (state) {
    ctx.effect(() => ctx.connection.fetch.register(createWebModeRoute(state)))
    installDualWebEntry(ctx, state)
  }
  const codexAvailable = () => !state || state.preferences.coexist || webModeFor(state.preferences) === 'codex'
  const register = (route, scope = ctx) => scope.effect(() => scope.connection.fetch.register(state ? {
    ...route,
    fetch: request => codexAvailable() ? route.fetch(request) : new Response(null, { status: 404 }),
  } : route))
  const readWorkspace = async threadId => {
    const { thread } = await readCodex('thread/read', { threadId }, process.env.DSH_CHATGPT_SOCKET, owner.signal)
    return thread.cwd
  }
  if (!state) {
    // 独立实例的文件服务只需冷读工作目录。共存入口直接复用 DSH 的服务。
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionPersistence', { stat: async threadId => ({ header: { cwd: await readWorkspace(threadId) } }) })
    ctx.provide('sandboxPolicy', { workspaceRoot: process.cwd() })
  }
  for (const route of createHistoryRoutes(undefined, owner.signal, cacheDirectory, ctx.attachments)) {
    register(route)
  }
  const [{ formatCodexMarkdown }, { formatSessionMarkdown }, sessionMedia] = await Promise.all([
    import('../../dist/session-markdown.mjs'),
    ctx.loader.import('@deepseek-ai/dsh-session-log-export'),
    !state && loadSessionMedia(),
  ])
  if (sessionMedia) ctx.plugin(sessionMedia)
  const exportSession = createSessionExportRoute(process.env.DSH_CHATGPT_SOCKET, owner.signal,
    (thread, turns, cancelled) => formatCodexMarkdown(thread, turns, formatSessionMarkdown, cancelled))
  register(exportSession)
  const { WorkspaceFileSearch, DEFAULT_FILE_SEARCH_MAX_RESULTS, DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES } = await import('../../dist/file-reference-search.mjs')
  const searchConfig = { maxResults: DEFAULT_FILE_SEARCH_MAX_RESULTS, maxEntries: DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES }
  ctx.inject(['workspaceFiles', 'typert'], scope => {
    const workspaceFileScope = scope.typert.lookups.get('workspaceFileScope')
    const readFileScope = state
      ? async threadId => ({ sessionId: threadId, workspaceRoot: await readWorkspace(threadId) })
      : threadId => workspaceFileScope?.resolve(threadId)
    if (state && workspaceFileScope) {
      // 来源标记只用于浏览器的 Codex 文件请求，原生 DSH 会话继续按自己的规则解析。
      scope.typert.lookups.configure('workspaceFileScope', sessionId => {
        if (!sessionId.startsWith(codexFileScopePrefix)) return workspaceFileScope.resolve(sessionId)
        if (codexAvailable()) return readFileScope(sessionId.slice(codexFileScopePrefix.length))
      })
    }
    const references = createFileReferenceRoute(readFileScope, cwd => new WorkspaceFileSearch(cwd, searchConfig), owner.signal)
    const preview = createVisualizeRoute(async (threadId, path, signal) => {
      const files = await readFileScope(threadId)
      if (!files) throw new Error('找不到 Visualize 引用的工作区。')
      const { data } = await scope.workspaceFiles.readBytes(files, path, {
        range: { offset: 0, length: visualizeMaxBytes + 1 },
      }, signal)
      return data
    })
    register(preview, scope)
    register(references, scope)
  })
  // 仅复用 DSH 的目录选择入口。工作区列表和持久化仍由 Codex 提供。
  if (!state) {
    const { DirectoryPickerController } = await ctx.loader.import('@deepseek-ai/dsh-api-workspace-controller')
    ctx.plugin(DirectoryPickerController)
  }
}
