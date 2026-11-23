import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canKeepWebPage, defaultWebPreferences, webModeFor, webModePath } from '../shared/web-mode.js'

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

/** 读取当前 Web profile 的入口偏好。两种入口沿用同一套 Host 服务。 */
export async function openWebModes(profile) {
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
  return {
    get preferences() { return preferences },
    async save(value) {
      await mkdir(dir, { recursive: true })
      await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600 })
      preferences = value
    },
  }
}

export function webModeStatus(state, requested) {
  const preferences = state.preferences
  return { ...preferences, available: true, mode: webModeFor(preferences, requested) }
}

/** 同一 profile 串行保存模式偏好，读取等待尚在进行的保存完成。 */
export function createWebModeRoute(state) {
  let saving
  return {
    path: webModePath,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const requested = new URL(request.url).searchParams.get('mode')
      const status = () => webModeStatus(state, requested)
      if (request.method === 'GET') {
        await saving?.catch(() => {})
        return json(status())
      }

      const input = await request.json().catch(() => null)
      const patch = preferencePatch(input)
      if (!patch) return json({ error: '未知的 Web 模式设置。' }, 400)
      if (saving) return json({ ...status(), error: '正在切换 Web 模式。' }, 409)
      const previous = state.preferences
      if (input.keepPage && !canKeepWebPage(previous, patch)) {
        return json({ ...status(), error: '实例模式设置已变更，请按更新后的设置操作。' }, 409)
      }
      if (previous.exclusive && patch.exclusive === undefined) {
        return json({ ...status(), error: '请先退出 Codex 独占。' }, 409)
      }

      try {
        saving = state.save({ ...previous, ...patch })
        await saving
        return json(status())
      } catch (error) {
        return json({ ...status(), error: `无法保存 Web 模式设置。${error.message}` }, 500)
      } finally {
        saving = undefined
      }
    },
  }
}
