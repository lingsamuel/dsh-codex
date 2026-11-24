import { apply, inject } from '@deepseek-ai/dsh-client-ui-schedule/src/client/index.ts'
import { codexSchedulePath } from '../../shared/schedule-for-codex.js'

/** 管理页沿用官方组件，读写和变更通知只使用 Codex 的任务入口。 */
export function installCodexSchedule(ctx, signal) {
  const endpoint = new URL(codexSchedulePath.slice(1), document.baseURI)
  ctx.inject(inject, scope => apply(scope, {
    async request(method, params) {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), signal,
      })
      return response.json()
    },
    subscribe(listener) {
      const connection = new EventSource(endpoint)
      connection.addEventListener('message', listener)
      return () => connection.close()
    },
  }))
}
