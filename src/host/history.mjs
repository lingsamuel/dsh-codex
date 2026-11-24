import { isAbsolute, join } from 'node:path'
import { CodexRpcError, readCodex, withCodexReader } from './app-server.mjs'
import { createCatalogReader, readArchivedCatalog, readChildThreads, readProjectPage, readThreadSummary } from './catalog.mjs'
import { createWatchRoute } from './live-watch.mjs'
import { readThreadTurns } from './live-history.mjs'
import { createThreadActionRoute } from './thread-actions.mjs'
import { createProjectActionRoute, createProjectOpener } from './project-actions.mjs'
import { createPermissionActions } from './permissions.mjs'
import { createConversationActionRoute } from './conversation-actions.mjs'
import { createQuestionBridge } from './question-bridge.mjs'
import { createAsyncQuestionActionRoute } from './async-question-actions.mjs'
import { createModelDefaultRoute, readModelCatalog } from './models.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'
import { createThreadSubmissionQueue, isArchived } from './thread-runtime.mjs'
import { createBackgroundTerminalMonitor, readBackgroundTerminals } from './background-terminals.mjs'
import { createCommandActionRoute, readPlanModes, selectPlanMode } from './command-actions.mjs'
import { planModeOf } from '../shared/plan-mode.js'
import { createSkillsRoute } from './skills.mjs'
import { createCodexPluginRoutes } from './codex-plugins.mjs'
import { createCodexMcpRoutes } from './codex-mcp.mjs'
import { createWorktreeRoutes } from './worktree-actions.mjs'
import { createQueuedSteers } from './queued-steers.mjs'
import { createFileUploads } from './file-uploads.mjs'
import { createFirstSubmission } from './first-submission.mjs'
import { readThreadReferenceCandidates } from './thread-references.mjs'
import { createDefaultPreference } from './default-preference.mjs'
import { createThreadTitles } from './thread-titles.mjs'
import { createHistoryPreferences } from './history-preferences.mjs'
import { createOlderHistoryRoute, readOpeningFallback, readTurnDetails } from './history-pages.mjs'

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
export function createHistoryRoutes(socketPath = process.env.DSH_CODEX_SOCKET, ownerSignal, cacheDirectory, attachmentStore,
  submit = createThreadSubmissionQueue(), onDraftAccepted) {
  const readCatalog = createCatalogReader(socketPath, ownerSignal, cacheDirectory)
  const questions = createQuestionBridge(socketPath, ownerSignal)
  const steers = createQueuedSteers()
  const files = attachmentStore && createFileUploads(attachmentStore, socketPath, ownerSignal, steers)
  const openProject = createProjectOpener()
  const backgroundTerminals = createBackgroundTerminalMonitor(socketPath, ownerSignal)
  const permissions = createPermissionActions(socketPath, ownerSignal,
    cacheDirectory && join(cacheDirectory, 'web-permissions.json'), submit)
  const modelDefault = createDefaultPreference(cacheDirectory && join(cacheDirectory, 'web-model-default.json'), 'selection')
  const titles = createThreadTitles(socketPath, ownerSignal, submit, cacheDirectory)
  const historyPreferences = createHistoryPreferences(cacheDirectory)
  const submitFirst = createFirstSubmission(socketPath, submit, permissions, openProject, modelDefault.get, onDraftAccepted)
  const readDraftPlanMode = threadId => planModeOf(permissions.readDraftSettings(threadId))
  const enablePlan = (threadId, signal) => selectPlanMode(socketPath, signal, threadId, 'plan', false, permissions.observeDraftSettings)
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
    ...(files ? [files.upload, files.download] : []),
    createSkillsRoute(socketPath, ownerSignal),
    ...createCodexPluginRoutes(socketPath, ownerSignal),
    ...createCodexMcpRoutes(socketPath, ownerSignal),
    ...createWorktreeRoutes(socketPath, ownerSignal, submit),
    createProjectActionRoute(socketPath, ownerSignal, submit, openProject),
    permissions.catalogRoute,
    permissions.actionRoute,
    createModelDefaultRoute(socketPath, ownerSignal, modelDefault),
    titles.route,
    historyPreferences.route,
    createThreadActionRoute(socketPath, ownerSignal, submit, backgroundTerminals, permissions, titles),
    createCommandActionRoute(socketPath, ownerSignal, submit, permissions, submitFirst),
    createConversationActionRoute(socketPath, ownerSignal, submit, permissions, openProject, enablePlan, steers,
      files?.resolve, submitFirst, titles.schedule),
    questions.route,
    questions.approvalRoute,
    questions.mcpRoute,
    createAsyncQuestionActionRoute(socketPath, ownerSignal, submit, steers),
    createWatchRoute(socketPath, ownerSignal, questions, backgroundTerminals, readDraftPlanMode, steers, historyPreferences.get),
    createOlderHistoryRoute(socketPath, ownerSignal, historyPreferences.get),
    route('history-items', (query, signal) => {
      const itemIds = query.getAll('itemId')
      if (itemIds.length > 100 || itemIds.some(id => !id)) throw new CodexRpcError({ code: -32602, message: '原生条目 ID 无效。' })
      return readTurnDetails(socketPath, signal, requiredParam(query, 'threadId', '缺少 Codex 线程 ID。'),
        requiredParam(query, 'turnId', '缺少 Codex 轮次 ID。'), query.get('cursor'), itemIds)
    }),
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
    route('models', async (query, signal) => {
      const cwd = query.get('cwd')
      if (cwd !== null && !isAbsolute(cwd)) throw new CodexRpcError({ code: -32602, message: '请选择有效的工作目录。' })
      const catalog = await withCodexReader(socketPath, signal, rpc => readModelCatalog(rpc, cwd))
      const selection = cwd && await modelDefault.get()
      if (!selection) return catalog
      return { ...catalog, default: selection.model ? selection : { ...catalog.default, ...selection } }
    }),
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
    route('thread-references', (query, signal) => withCodexReader(socketPath, signal, rpc =>
      readThreadReferenceCandidates(rpc, query.get('threadId'), query.get('cwd'), query.get('query') ?? ''))),
    route('turns', (query, signal) => {
      const threadId = requiredParam(query, 'threadId', '缺少 Codex 线程 ID。')
      if (query.get('opening') === '1') return readOpeningFallback(socketPath, signal, threadId, historyPreferences.get)
      return withCodexReader(socketPath, signal, request => readThreadTurns(request, {
        threadId,
        limit: 25,
        sortDirection: 'desc',
        itemsView: 'full',
        ...optionalParams(query, ['cursor']),
      }))
    }),
  ]
}
