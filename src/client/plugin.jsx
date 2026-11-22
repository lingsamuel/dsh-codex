import { createHistoryCatalog } from './catalog.js'
import { provideCodexControllers } from './native-dsh/controllers.js'
import { installLiveStatus } from './native-dsh/live-status.jsx'

export const inject = ['slots', 'locale']

export function apply(ctx) {
  const controller = new AbortController()
  const catalog = createHistoryCatalog(controller.signal)
  ctx.effect(() => () => controller.abort())

  ctx.slots.provideRoot({ hooks: { codexHistory: catalog.store } })
  provideCodexControllers(ctx, catalog)
  installLiveStatus(ctx)
  ctx.slots.inject('conversation.composer.bar', () => ctx.slots.register(
    { name: 'conversation.composer.bar', priority: -1 },
    HistoryStatus,
  ))
}

function HistoryStatus({ useCodexHistory }) {
  const { busy, error, selected } = useCodexHistory(state => state)
  if (error) return <p role="alert">{error}</p>
  if (selected) return null
  return <p role="status">{busy ? '正在载入会话…' : '选择一个 Codex 会话浏览历史'}</p>
}
