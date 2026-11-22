import { CodexRpcError, readCodex, readCodexPages, withCodexReader } from './app-server.mjs'
import { createCatalogReader, readArchivedCatalog, readChildThreads, readProjectPage } from './catalog.mjs'
import { createWatchRoute } from './live-watch.mjs'
import { readThreadTurns } from './live-history.mjs'
import { readTurnOutline } from './turn-outline.mjs'
import { createThreadActionRoute } from './thread-actions.mjs'
import { createConversationActionRoute } from './conversation-actions.mjs'
import { createQuestionBridge } from './question-bridge.mjs'
import { createAsyncQuestionActionRoute } from './async-question-actions.mjs'
import { readModelCatalog } from './models.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'

function optionalParams(query, keys) {
  const result = {}
  for (const key of keys) {
    if (query.has(key)) result[key] = query.get(key)
  }
  return result
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function requiredParam(query, key, message) {
  const value = query.get(key)
  if (!value?.trim()) throw new CodexRpcError({ code: -32602, message })
  return value
}

/** 将 Codex 浏览与会话管理入口注册在 DSH 的受保护 API 下。 */
export function createHistoryRoutes(socketPath = process.env.DSH_CHATGPT_SOCKET, ownerSignal, cacheDirectory) {
  const readCatalog = createCatalogReader(socketPath, ownerSignal, cacheDirectory)
  const questions = createQuestionBridge(socketPath, ownerSignal)
  const route = (path, read) => ({
    path: `/api/codex/${path}`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return json(await read(new URL(request.url).searchParams, request.signal))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法读取 Codex。请检查当前环境的共享 App Server 是否正在运行。' }, 503)
      }
    },
  })
  const native = (method, parameters) => (query, signal) => readCodex(method, parameters(query), socketPath, signal)

  return [
    createThreadActionRoute(socketPath, ownerSignal),
    createConversationActionRoute(socketPath, ownerSignal),
    questions.route,
    createAsyncQuestionActionRoute(socketPath, ownerSignal),
    createWatchRoute(socketPath, ownerSignal, questions),
    route('catalog', query => readCatalog(query.get('complete') === '1', query.get('fresh') === '1')),
    route('archived', (_, signal) => readArchivedCatalog(socketPath, signal)),
    route('children', (query, signal) => readChildThreads(requiredParam(query, 'threadId', '缺少 Codex 线程 ID。'), socketPath, signal, query.get('archived') === '1')),
    route('models', (_, signal) => withCodexReader(socketPath, signal, readModelCatalog)),
    route('thread-info', (query, signal) => {
      const threadId = requiredParam(query, 'threadId', '缺少 Codex 线程 ID。')
      const view = query.get('view')
      return withCodexReader(socketPath, signal, async request => {
        function unavailable(error) {
          if (error.code === -32601 || error.code === -32602) return null
          throw error
        }
        const [reading, goalResult] = await Promise.all([
          view === 'goal' ? undefined : request('thread/read', { threadId }),
          !view || view === 'goal' ? request('thread/goal/get', { threadId }).catch(unavailable) : undefined,
        ])
        const thread = reading?.thread
        const terminals = (!view || view === 'ps') && thread?.status?.type && thread.status.type !== 'notLoaded'
          ? await readCodexPages(cursor => request('thread/backgroundTerminals/list', {
            threadId, limit: 50, ...(cursor && { cursor }),
          })).catch(unavailable)
          : undefined
        return { model: thread?.model, reasoningEffort: thread?.reasoningEffort, goal: goalResult?.goal ?? null, terminals }
      })
    }),
    route('projects', (query, signal) => readProjectPage(
      (method, params) => readCodex(method, params, socketPath, signal),
      { limit: 60, ...optionalParams(query, ['cursor']) },
    )),
    route('threads', native('thread/list', query => ({
      limit: 60,
      sortKey: 'updated_at',
      modelProviders: [],
      ...optionalParams(query, ['cwd', 'cursor', 'projectId']),
    }))),
    route('search', async (query, signal) => {
      const page = await readCodex('thread/search', {
        searchTerm: requiredParam(query, 'searchTerm', '缺少搜索内容。'),
        sortKey: 'updated_at',
        limit: 20,
        ...(query.get('archived') === '1' && { archived: true }),
        ...optionalParams(query, ['cursor']),
      }, socketPath, signal)
      const workspacePaths = await resolveWorkspacePaths(page.data.map(({ thread }) => thread.cwd))
      return { ...page, workspacePaths }
    }),
    route('search-occurrences', native('thread/searchOccurrences', query => ({
      threadId: requiredParam(query, 'threadId', '缺少 Codex 线程 ID。'),
      searchTerm: requiredParam(query, 'searchTerm', '缺少搜索内容。'),
      limit: 20,
      ...optionalParams(query, ['cursor']),
    }))),
    route('turn-outline', (query, signal) => {
      const threadId = requiredParam(query, 'threadId', '缺少 Codex 线程 ID。')
      const cursor = requiredParam(query, 'cursor', '缺少较早轮次的游标。')
      return withCodexReader(socketPath, signal, request => readTurnOutline(request, threadId, cursor), 90_000)
    }),
    route('turns', (query, signal) => withCodexReader(socketPath, signal, request => readThreadTurns(request, {
        threadId: requiredParam(query, 'threadId', '缺少 Codex 线程 ID。'),
        limit: 25,
        sortDirection: 'desc',
        itemsView: 'full',
        ...optionalParams(query, ['cursor']),
    }))),
  ]
}
