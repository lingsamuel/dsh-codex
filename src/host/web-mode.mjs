import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canKeepWebPage, defaultWebPreferences, singleCodexFor, webModeFor, webModePath } from '../shared/web-mode.js'
import { webModePage } from './web-mode-page.mjs'

const maskBundle = 'dsh-chatgpt-web-mask'
const controller = 'session-controller'

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function preferencePatch(input) {
  if (!input || typeof input !== 'object') return
  const { coexist, exclusive, defaultMode } = input
  if (typeof coexist === 'boolean') return { coexist }
  if (typeof exclusive === 'boolean') return { exclusive }
  if (defaultMode === 'dsh' || defaultMode === 'codex') return { defaultMode }
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

async function cleanMaskOnDisable(ctx, profile) {
  const { runProfilePnpm } = await ctx.loader.import('@deepseek-ai/dsh-plugin-manager/operations')
  const logger = ctx.logger
  const ownerSelected = manifest => manifest.dsh?.profile?.bundles?.includes('dsh-chatgpt')
  ctx.effect(() => () => {
    if (ownerSelected(readManifest(profile.dir))) return
    // 管理器可能仍持有清单写锁。卸载完成后在同一把锁下清理关联依赖，
    // 由 DSH 的 profile 观察器重新装配原生控制器。
    void withFileLock(join(profile.dir, 'package.json'), async () => {
      const manifest = readManifest(profile.dir)
      if (ownerSelected(manifest) || !manifest.dependencies?.[maskBundle]) return
      const result = await runProfilePnpm({
        profile: profile.name, dir: profile.dir, cwd: profile.cwd, installAnchor: profile.installAnchor,
      }, ['remove', maskBundle], {
        ...profile.packageManager, execution: 'service', outputBytes: 4096, idleTimeoutMs: 15_000,
      })
      if (result.exitCode !== 0) logger.warn('清理 Web 模式配置失败：%s', result.output)
    }).catch(error => logger.warn(error))
  })
}

export async function openWebModes(ctx, profile, loadSessionMedia) {
  const dir = join(profile.dir, 'dsh-chatgpt')
  const path = join(dir, 'web-mode.json')
  const stored = await readFile(path, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error
  })
  let preferences = {
    ...defaultWebPreferences,
    ...preferencePatch({ coexist: stored?.coexist }),
    ...preferencePatch({ exclusive: stored?.exclusive }),
    ...preferencePatch({ defaultMode: stored?.defaultMode }),
  }
  let resources
  await cleanMaskOnDisable(ctx, profile)

  async function attachCodexResources() {
    if (resources) return
    const [sessionMedia, { DirectoryPickerController }] = await Promise.all([
      loadSessionMedia(),
      ctx.loader.import('@deepseek-ai/dsh-api-workspace-controller'),
    ])
    const fiber = ctx.plugin(async scope => {
      await Promise.all([
        scope.plugin(sessionMedia).await(),
        scope.plugin(DirectoryPickerController).await(),
      ])
    })
    try {
      await fiber.await()
      resources = fiber
    } catch (error) {
      await fiber.dispose()
      throw error
    }
  }

  async function prepareMask(manager) {
    const location = join(dir, maskBundle)
    await mkdir(location, { recursive: true })
    await writeFile(join(location, 'package.json'), JSON.stringify({
      name: maskBundle, version: '1.0.0', private: true,
      dsh: { bundle: { patch: './cordis.patch.yml', listedByDefault: false } },
    }))
    // 插件停用或卸载时，残留的内部 bundle 不再停用 DSH 控制器。
    const disabled = `(() => {
      const profile = ctx.get('profileContext');
      try {
        return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(profile.dir + '/package.json', 'utf8'))
          .dsh.profile.bundles.includes('dsh-chatgpt');
      } catch { return false; }
    })()`
    await writeFile(join(location, 'cordis.patch.yml'), [controller, 'workspace-controller', 'file-upload', 'ui-deliverables'].map(id =>
      `- id: ${id}\n  disabled: !!js ${JSON.stringify(disabled)}\n`).join(''))
    const result = await manager.installBundle('link:' + location, { enabled: false })
    assertApplied(result)
  }

  const masked = () => readManifest(profile.dir).dsh?.profile?.bundles?.includes(maskBundle) ?? false
  const nativeReady = mask => Boolean(ctx.get('sessionController')) === !mask
  const ready = mask => nativeReady(mask) && Boolean(resources) === mask
  if (masked() && nativeReady(true)) {
    await attachCodexResources().catch(error => ctx.logger.warn(error))
  }

  return {
    get preferences() { return preferences },
    masked,
    ready,
    async save(value) {
      await mkdir(dir, { recursive: true })
      await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600 })
      preferences = value
    },
    async reconcile(mask) {
      const manager = ctx.get('pluginManager')
      if (!manager) throw new Error('DSH 插件管理器不可用。')
      if (mask) {
        const installed = (await manager.listBundles()).find(row => row.name === maskBundle)?.installed
        if (!installed) await prepareMask(manager)
      } else if (resources) {
        await resources.dispose()
        resources = undefined
      }
      if (mask !== masked()) {
        assertApplied(await manager.setBundleEnabled(maskBundle, mask))
      } else if (!nativeReady(mask)) {
        const hmr = ctx.get('hmr')
        const { restartReason, pending } = await hmr.runExclusive(() => hmr.reconcileProfile(mask ? [] : [controller]))
        if (restartReason || pending.length) throw new Error('DSH 需要重启才能恢复会话控制器。')
      }
      if (!nativeReady(mask)) {
        throw new Error('DSH 会话控制器未切换。请检查本实例的配置覆盖。')
      }
      if (mask) await attachCodexResources()
    },
  }
}

function assertApplied(result) {
  if (result.application !== 'applied') {
    throw new Error(result.error?.diagnostic || result.error?.code || 'DSH 未能应用模式配置。')
  }
}

function nativeSessionIsBusy(ctx) {
  if (ctx.get('agents')?.list().some(agent => agent.status === 'running')) return true
  const projections = ctx.get('sessionProjections')
  return Boolean(projections && ctx.get('sessions')?.list().some(session =>
    projections.snapshot(session, ['userQuestions']).values.userQuestions?.active?.length))
}

export function webModeStatus(ctx, state, requested) {
  const preferences = state.preferences
  const expected = singleCodexFor(preferences)
  return {
    ...preferences,
    available: Boolean(ctx.get('hmr')),
    mode: state.masked() === expected && state.ready(expected) ? webModeFor(preferences, requested) : 'recovery',
  }
}

/** 先等已有写请求退出，再完成装配和设置持久化。过渡期间拒绝新的写请求。 */
export function createWebModeRoute(ctx, state) {
  let transition
  let pendingWrites = 0
  ctx.on('connection/request', async (request, response, next) => {
    const method = request.method
    if (method === 'GET' || method === 'HEAD' || request.url?.split('?')[0] === webModePath) return next()
    if (transition) {
      response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: '正在切换 Web 模式。' }))
      return
    }
    pendingWrites++
    try {
      return await next()
    } finally {
      pendingWrites--
    }
  })

  return {
    path: webModePath,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url)
      const requested = url.searchParams.get('mode')
      const status = () => webModeStatus(ctx, state, requested)
      if (request.method === 'GET') {
        if (url.searchParams.has('recovery')) return webModePage()
        await transition?.promise
        return json(status())
      }
      if (request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) {
        const form = new URLSearchParams(await request.text())
        const patch = form.has('restore') ? { restore: true } : preferencePatch({
          ...(form.has('coexist') && { coexist: form.get('coexist') === 'true' }),
          ...(form.has('exclusive') && { exclusive: form.get('exclusive') === 'true' }),
          defaultMode: form.get('defaultMode'),
        })
        return patch ? webModePage(patch, requested) : json({ error: '未知的 Web 模式设置。' }, 400)
      }

      const input = await request.json().catch(() => null)
      const patch = input?.restore === true
        ? { exclusive: false, defaultMode: 'dsh' }
        : preferencePatch(input)
      if (!patch) return json({ error: '未知的 Web 模式设置。' }, 400)
      if (transition) return json({ ...status(), error: '正在切换 Web 模式。' }, 409)
      if (status().mode === 'recovery' && input?.restore !== true) {
        return json({ ...status(), error: '请先恢复 DSH 模式。' }, 409)
      }

      const previous = state.preferences
      if (input?.keepPage && !canKeepWebPage(previous, patch)) {
        return json({ ...status(), error: '实例模式设置已变更，请按更新后的设置操作。' }, 409)
      }
      if (previous.exclusive && patch.exclusive === undefined) {
        return json({ ...status(), error: '请先退出 Codex 独占。' }, 409)
      }
      const before = state.masked()
      const next = { ...previous, ...patch }
      const after = singleCodexFor(next)
      const reconcile = before !== after || input?.restore === true
      const topologyChanged = previous.coexist !== next.coexist || previous.exclusive !== next.exclusive || reconcile
      if (topologyChanged && pendingWrites) return json({ ...status(), error: '请等待当前的 Web 请求处理完成后重试。' }, 409)
      if (reconcile && !ctx.get('hmr')) return json({ ...status(), error: 'DSH 热重载不可用。' }, 503)
      if (!before && after && nativeSessionIsBusy(ctx)) {
        return json({ ...status(), error: 'DSH 仍在执行或等待交互，请先处理当前轮次。' }, 409)
      }

      transition = Promise.withResolvers()
      try {
        if (reconcile) await state.reconcile(after)
        await state.save(next)
        return json(status())
      } catch (error) {
        try {
          if (reconcile) await state.reconcile(before)
          return json({ ...status(), error: `切换失败，已恢复原模式。${error.message}` }, 500)
        } catch (rollback) {
          return json({ ...status(), mode: 'recovery', error: `切换失败。${error.message} 恢复失败。${rollback.message}` }, 500)
        }
      } finally {
        transition.resolve()
        transition = undefined
      }
    },
  }
}
