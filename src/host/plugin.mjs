import { createHistoryRoutes } from './history.mjs'

export const name = 'dsh-chatgpt'
export const inject = ['connection']

export function apply(ctx) {
  const owner = new AbortController()
  ctx.effect(() => () => owner.abort())
  for (const route of createHistoryRoutes(undefined, owner.signal, process.env.DSH_CHATGPT_CACHE_DIR)) {
    ctx.effect(() => ctx.connection.fetch.register(route))
  }
}
