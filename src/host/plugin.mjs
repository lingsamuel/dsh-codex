import { createHistoryRoutes } from './history.mjs'
import { readCodex } from './app-server.mjs'

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
  // 仅复用 DSH 的目录选择入口。工作区列表和持久化仍由 Codex 提供。
  const { DirectoryPickerController } = await ctx.loader.import('@deepseek-ai/dsh-api-workspace-controller')
  ctx.plugin(DirectoryPickerController)
}
