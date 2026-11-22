import { join } from 'node:path'
import { CodexRpcError, readCodex, withCodexReader } from './app-server.mjs'
import { createCatalogReader, readArchivedCatalog, readChildThreads, readProjectPage, readThreadSummary } from './catalog.mjs'
import { createWatchRoute } from './live-watch.mjs'
import { readThreadTurns } from './live-history.mjs'
import { readTurnOutline } from './turn-outline.mjs'
import { createThreadActionRoute } from './thread-actions.mjs'
import { createProjectActionRoute } from './project-actions.mjs'
import { createPermissionActions } from './permissions.mjs'
import { createConversationActionRoute } from './conversation-actions.mjs'
import { createQuestionBridge } from './question-bridge.mjs'
import { createAsyncQuestionActionRoute } from './async-question-actions.mjs'
import { readModelCatalog } from './models.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { createThreadSubmissionQueue, isArchived } from './thread-runtime.mjs'
import { createBackgroundTerminalMonitor, readBackgroundTerminals } from './background-terminals.mjs'
import { createCommandActionRoute, readPlanModes } from './command-actions.mjs'
import { planModeOf } from '../shared/plan-mode.js'
import { createSkillsRoute } from './skills.mjs'
import { createCodexPluginRoutes } from './codex-plugins.mjs'
import { createCodexMcpRoutes } from './codex-mcp.mjs'
import { createWorktreeRoutes } from './worktree-actions.mjs'

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

function unavailable(error) {
  if (error.code === -32601 || error.code === -32602) return null
  throw error
}

async function readThreadTerminals(request, threadId, status) {
  if (status === 'notLoaded') return []
  if (!status) return undefined

  try {
    return await readBackgroundTerminals(request, threadId)
  } catch (error) {
    // 线程可能在两次原生调用之间卸载，重读运行时状态再区分空列表和请求错误。
    if (error.code === -32600 || error.code === -32602) {
      const { thread } = await request('thread/read', { threadId })
      if (thread?.status?.type === 'notLoaded') return []
    }
    return unavailable(error)
  }
}

/** 将 Codex 浏览与会话管理入口注册在 DSH 的受保护 API 下。 */
export function createHistoryRoutes(socketPath = process.env.DSH_CHATGPT_SOCKET, ownerSignal, cacheDirectory) {
  const readCatalog = createCatalogReader(socketPath, ownerSignal, cacheDirectory)
  const questions = createQuestionBridge(socketPath, ownerSignal)
  const submit = createThreadSubmissionQueue()
  const backgroundTerminals = createBackgroundTerminalMonitor(socketPath, ownerSignal)
  const permissions = createPermissionActions(socketPath, ownerSignal,
    cacheDirectory && join(cacheDirectory, 'web-permissions.json'), submit)
  const readDraftPlanMode = threadId => planModeOf(permissions.readDraftSettings(threadId))
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
    createSkillsRoute(socketPath, ownerSignal),
    ...createCodexPluginRoutes(socketPath, ownerSignal),
    ...createCodexMcpRoutes(socketPath, ownerSignal),
    ...createWorktreeRoutes(socketPath, ownerSignal, submit),
    createProjectActionRoute(socketPath, ownerSignal),
    permissions.catalogRoute,
    permissions.actionRoute,
    createThreadActionRoute(socketPath, ownerSignal, submit, backgroundTerminals, permissions),
    createCommandActionRoute(socketPath, ownerSignal, submit, permissions),
    createConversationActionRoute(socketPath, ownerSignal, submit, permissions),
    questions.route,
    questions.approvalRoute,
    questions.mcpRoute,
    createAsyncQuestionActionRoute(socketPath, ownerSignal, submit),
    createWatchRoute(socketPath, ownerSignal, questions, backgroundTerminals, readDraftPlanMode),
    route('catalog', query => readCatalog(query.get('complete') === '1', query.get('fresh') === '1')),
    route('archived', (_, signal) => readArchivedCatalog(socketPath, signal)),
    route('children', (query, signal) => {
      const threadId = requiredParam(query, 'threadId', '缺少 Codex 线程 ID。')
      return withCodexReader(socketPath, signal, request => readChildThreads(request, threadId, query.get('archived') === '1'))
    }),
    route('thread-summary', (query, signal) => {
      const threadId = requiredParam(query, 'threadId', '缺少 Codex 线程 ID。')
      return withCodexReader(socketPath, signal, request => readThreadSummary(request, threadId))
    }),
    route('models', (_, signal) => withCodexReader(socketPath, signal, readModelCatalog)),
    route('thread-info', (query, signal) => {
      const threadId = requiredParam(query, 'threadId', '缺少 Codex 线程 ID。')
      const view = query.get('view')
      return withCodexReader(socketPath, signal, async request => {
        if (view === 'plan') return { modes: await readPlanModes(request), mode: readDraftPlanMode(threadId) }
        if (view === 'goal') {
          try {
            return await request('thread/goal/get', { threadId })
          } catch (error) {
            if (error.code === -32600 && error.message.startsWith('thread not found:') && await isArchived(request, threadId)) {
              return { goal: null, goalRequiresUnarchive: true }
            }
            unavailable(error)
            return { goal: null, goalAvailable: false }
          }
        }
        const [reading, goalResult] = await Promise.all([
          request('thread/read', { threadId }),
          !view ? request('thread/goal/get', { threadId }).catch(unavailable) : undefined,
        ])
        const thread = reading?.thread
        const terminals = !view || view === 'ps'
          ? await readThreadTerminals(request, threadId, thread?.status?.type)
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
