import { createHistoryRoutes } from './history.mjs'

export const name = 'dsh-chatgpt'
export const inject = ['connection']

export function apply(ctx) {
  for (const route of createHistoryRoutes()) {
    ctx.effect(() => ctx.connection.fetch.register(route))
  }
}
