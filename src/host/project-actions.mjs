import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, normalize } from 'node:path'
import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { readProjects, readProjectSnapshot, readThreads } from './catalog.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'

const methods = { rename: 'project/update', move: 'project/move', delete: 'project/delete' }

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function findOrCreateProject(request, path) {
  const projects = await readProjects(request)
  const roots = projects.flatMap(project => project.roots.map(root => root.path))
  const paths = await resolveWorkspacePaths(roots)
  const existing = projects.find(project => project.roots.some(root => (paths[root.path] ?? root.path) === path))
  if (existing) return existing
  const { project } = await request('project/create', {
    name: basename(path) || path, roots: [{ path }], idempotencyKey: randomUUID(),
  })
  return project
}

/** 同一 Host 的添加、工作树首发和分组转换共用按原生目录归一的项目创建。 */
export function createProjectOpener() {
  const creating = new Map()
  return async function openProject(request, cwd) {
    const workspacePaths = await resolveWorkspacePaths([cwd])
    const path = workspacePaths[cwd] ?? cwd
    if (!creating.has(path)) {
      creating.set(path, findOrCreateProject(request, path).finally(() => creating.delete(path)))
    }
    return { project: await creating.get(path), workspacePaths }
  }
}

async function directoryThreads(request, directory) {
  // Codex 的 cwd 筛选按字符串精确匹配，先找出不同拼写的候选，再用侧栏的规则识别同一目录。
  const pages = await Promise.all([false, true].map(archived => readThreads(request, { archived, projectId: null })))
  const candidatePath = path => normalize(path).toLowerCase()
  const key = candidatePath(directory)
  const candidates = pages.flat().filter(thread => thread.cwd && !thread.projectId && !thread.ephemeral
    && candidatePath(thread.cwd) === key)
  const paths = await resolveWorkspacePaths([directory, ...candidates.map(thread => thread.cwd)])
  const path = paths[directory] ?? directory
  return candidates.filter(thread => (paths[thread.cwd] ?? thread.cwd) === path)
}

async function promoteDirectory(request, cwd, submit, openProject) {
  const threads = await directoryThreads(request, cwd)
  const { project } = await openProject(request, cwd)
  const snapshot = await readProjectSnapshot(request)
  const moved = []
  const failed = []
  for (const { id, cwd: originalCwd } of threads) {
    try {
      const changed = await submit(id, async () => {
        // 清单读取与迁移之间可能有另一端更新。只处理仍属于这个目录分组的会话。
        const { thread } = await request('thread/read', { threadId: id })
        if (thread.projectId || thread.cwd !== originalCwd) return false
        await request('thread/metadata/update', { threadId: id, projectId: project.id })
        return true
      })
      if (changed) moved.push(id)
    } catch (error) {
      failed.push({ threadId: id, message: error.message })
    }
  }
  return { ...snapshot, projectId: project.id, moved, failed }
}

/** 用原生项目列表确认写入，并保留 Codex 返回的排序。 */
export function createProjectActionRoute(socketPath, ownerSignal, submit, openProject) {
  const promotions = new Map()
  return {
    path: '/api/codex/project-action',
    methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const { action, projectId, name, beforeProjectId, cwd } = (await request.json().catch(() => null)) ?? {}
      const signal = ownerSignal ? AbortSignal.any([ownerSignal, request.signal]) : request.signal
      try {
        if (action === 'promote') {
          if (typeof cwd !== 'string' || !isAbsolute(cwd)) return json({ error: '请选择有效的目录分组。' }, 400)
          const paths = await resolveWorkspacePaths([cwd])
          const directory = paths[cwd] ?? cwd
          signal.throwIfAborted()
          if (!promotions.has(directory)) {
            const pending = withCodexReader(socketPath, ownerSignal, rpc => promoteDirectory(rpc, directory, submit, openProject), 90_000)
              .finally(() => promotions.delete(directory))
            promotions.set(directory, pending)
          }
          return json(await promotions.get(directory))
        }
        if (!Object.hasOwn(methods, action) || typeof projectId !== 'string' || !projectId.trim()
          || (action === 'rename' && (typeof name !== 'string' || !name.trim()))
          || (action === 'move' && beforeProjectId != null && (typeof beforeProjectId !== 'string' || !beforeProjectId.trim()))) {
          return json({ error: '无效的项目操作。' }, 400)
        }
        const params = { projectId }
        if (action === 'rename') params.name = name.trim()
        if (action === 'move' && beforeProjectId != null) params.beforeProjectId = beforeProjectId
        return json(await withCodexReader(socketPath, signal, async rpc => {
          await rpc(methods[action], params)
          return readProjectSnapshot(rpc)
        }))
      } catch (error) {
        if (error instanceof CodexRpcError) return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        return json({ error: '无法确认 Codex 项目操作。' }, 503)
      }
    },
  }
}
