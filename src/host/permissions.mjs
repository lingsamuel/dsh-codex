import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpcError, openCodexReader, readCodexPages, withCodexReader } from './app-server.mjs'
import { hasNoMaterializedHistory } from './live-history.mjs'
import { addressableThread, createThreadSubmissionQueue, isArchived } from './thread-runtime.mjs'
import { permissionOf } from '../shared/permissions.js'

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function invalid(message) {
  return new CodexRpcError({ code: -32602, message })
}

function required(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(message)
  return value
}

async function permissionProfiles(request, cwd) {
  const profiles = await readCodexPages(cursor => request('permissionProfile/list', {
    ...(cwd && { cwd }), ...(cursor && { cursor }),
  }))
  return profiles.filter(profile => profile.allowed && typeof profile.id === 'string')
    .map(({ id, description }) => ({ id, ...(description && { description }) }))
}

async function requireProfile(request, cwd, profileId) {
  if (!(await permissionProfiles(request, cwd)).some(profile => profile.id === profileId)) {
    throw invalid('当前工作目录不允许这个 Codex 权限预设。')
  }
}

function createDefaultPreference(path) {
  let profileId = null
  let writes = Promise.resolve()
  return {
    async get() {
      await writes
      if (!path) return profileId
      const saved = await readFile(path, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      return saved == null ? null : JSON.parse(saved).profileId ?? null
    },
    set(value) {
      const write = writes.then(async () => {
        if (path) {
          const temporary = `${path}.${randomUUID()}.tmp`
          try {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(temporary, JSON.stringify({ profileId: value }), { mode: 0o600 })
            await rename(temporary, path)
          } finally {
            await rm(temporary, { force: true })
          }
        }
        profileId = value
      })
      writes = write.catch(() => {})
      return write
    },
  }
}

/** 切换是显式操作。冷会话在恢复时应用预设，避免队列先用旧策略运行。 */
export async function updateThreadPermission(request, threadId, profileId, waitForConfirmation, readDraftPermission) {
  const thread = await addressableThread(request, threadId)
  await requireProfile(request, thread.cwd, profileId)
  const cold = thread.status?.type === 'notLoaded'
  if (cold && await isArchived(request, threadId)) throw invalid('请先取消归档再切换会话权限。')
  if (!readDraftPermission && !cold && !thread.preview && thread.historyMode === 'paginated') {
    try {
      await request('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' })
    } catch (error) {
      if (!hasNoMaterializedHistory(error)) throw error
      // 没有创建连接的空线程可以提交设置，但暂时无法订阅其确认通知。
      await request('thread/settings/update', { threadId, permissions: profileId })
      return { profileId, source: 'requested' }
    }
  }
  // 热附加只在用户主动切换时发生，为本次操作接收 Codex 的实际设置通知。
  const permission = readDraftPermission && !cold ? readDraftPermission()
    : permissionOf(await request('thread/resume', { threadId, excludeTurns: true, ...(cold && { permissions: profileId }) }))
  if (permission?.profileId === profileId) return permission
  await request('thread/settings/update', { threadId, permissions: profileId })
  return waitForConfirmation()
}

/** 同源设置接口只修改 DSH 的新会话默认值或明确指定的 Codex 线程。 */
export function createPermissionActions(socketPath, ownerSignal, preferencePath, submit = createThreadSubmissionQueue()) {
  const preference = createDefaultPreference(preferencePath)
  const known = new Map()
  const drafts = new Map()

  function storePermission(threadId, permission) {
    if (!permission) return undefined
    known.delete(threadId)
    known.set(threadId, permission)
    if (known.size > 100) known.delete(known.keys().next().value)
    return permission
  }

  function remember(threadId, settings) {
    return storePermission(threadId, permissionOf(settings))
  }

  /** 保留网页草稿的创建订阅，空线程尚不能经 resume 接收原生设置确认。 */
  async function withThreadCreation(signal, create) {
    const creation = new AbortController()
    const lifetime = ownerSignal ? AbortSignal.any([creation.signal, ownerSignal]) : creation.signal
    const abort = () => creation.abort(signal.reason)
    signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
    let connection
    let draft
    let retained = false
    try {
      connection = await openCodexReader(socketPath, lifetime, ({ method, params }) => {
        if (!draft || params?.threadId !== draft.id) return
        if (method === 'thread/settings/updated') {
          draft.permission = remember(draft.id, params.threadSettings)
          draft.confirm?.(draft.permission)
        } else if (['turn/started', 'thread/archived', 'thread/deleted', 'thread/closed'].includes(method)) {
          // 原生开始首轮后可按普通线程处理。已在等待的设置确认仍使用创建订阅。
          draft.finished = true
          if (!draft.confirm) connection.close()
        }
      })
      const result = await create(connection.request, started => {
        const id = started.thread.id
        draft = { id, connection, permission: remember(id, started) }
        return draft.permission
      })
      signal.throwIfAborted()
      if (draft && !draft.finished) {
        drafts.set(draft.id, draft)
        void connection.closed.then(() => drafts.delete(draft.id))
        retained = true
      }
      return result
    } finally {
      signal.removeEventListener('abort', abort)
      if (!retained) connection?.close()
    }
  }

  async function switchPermission(threadId, profileId, signal) {
    const deadline = new AbortController()
    const lifetime = AbortSignal.any([signal, deadline.signal, AbortSignal.timeout(15_000)])
    const { promise, resolve } = Promise.withResolvers()
    const draft = drafts.get(threadId)
    function confirm(permission) {
      if (permission?.profileId === profileId) resolve(permission)
    }
    if (draft) draft.confirm = confirm
    let connection
    try {
      connection = await openCodexReader(socketPath, lifetime, ({ method, params }) => {
        if (method !== 'thread/settings/updated' || params?.threadId !== threadId) return
        confirm(remember(threadId, params.threadSettings))
      })
      const permission = await updateThreadPermission(connection.request, threadId, profileId, () => Promise.race([
        promise,
        delay(5_000, undefined, { signal: lifetime }).then(() => {
          throw new CodexRpcError({ code: -32600, message: 'Codex 尚未确认权限切换，请查看当前模式后重试。' })
        }),
      ]), draft && (() => draft.permission))
      return { permission: storePermission(threadId, permission) }
    } finally {
      deadline.abort()
      connection?.close()
      if (draft) {
        draft.confirm = undefined
        if (draft.finished) draft.connection.close()
      }
    }
  }

  function route(path, method, run) {
    return {
      path: `/api/codex/${path}`, methods: [method], requestBody: 'buffered',
      async fetch(request) {
        const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
        try {
          return json(await run(request, signal))
        } catch (error) {
          if (error instanceof CodexRpcError) return json({ error: error.message }, error.code === -32602 ? 400 : 409)
          return json({ error: '无法读取或保存 Codex 权限。' }, 503)
        }
      },
    }
  }

  return {
    remember,
    withThreadCreation,
    async startOptions(request, cwd) {
      const profileId = await preference.get()
      if (profileId === null) return {}
      await requireProfile(request, cwd, profileId)
      return { permissions: profileId }
    },
    catalogRoute: route('permissions', 'GET', async (request, signal) => {
      const threadId = new URL(request.url).searchParams.get('threadId')
      return withCodexReader(socketPath, signal, async rpc => {
        const thread = threadId ? (await rpc('thread/read', { threadId })).thread : undefined
        const [profiles, defaultProfile] = await Promise.all([permissionProfiles(rpc, thread?.cwd), preference.get()])
        const cached = known.get(threadId)
        const permission = drafts.get(threadId)?.permission
          ?? (cached?.source === 'runtime' ? { ...cached, source: 'saved' } : cached)
        return { profiles, defaultProfile, ...(permission && { permission }) }
      })
    }),
    actionRoute: route('permission-action', 'POST', async (request, signal) => {
      const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') throw invalid('只接受 JSON 请求。')
      const { action, profileId, threadId } = (await request.json().catch(() => null)) ?? {}
      if (action === 'default') {
        if (profileId !== null) await withCodexReader(socketPath, signal,
          rpc => requireProfile(rpc, undefined, required(profileId, '缺少 Codex 权限预设。')))
        await preference.set(profileId)
        return { defaultProfile: profileId }
      }
      if (action !== 'select') throw invalid('无效的权限操作。')
      required(threadId, '缺少 Codex 线程 ID。')
      required(profileId, '缺少 Codex 权限预设。')
      return submit(threadId, () => switchPermission(threadId, profileId, signal))
    }),
  }
}
