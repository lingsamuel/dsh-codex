import { createHistoryCatalog } from './catalog.js'
import { provideCodexControllers } from './native-dsh/controllers.js'
import { installLiveStatus } from './native-dsh/live-status.jsx'
import { installMessageSearch } from './native-dsh/message-search.jsx'
import { installArchiveView } from './native-dsh/archive-view.jsx'
import { installTurnChanges } from './native-dsh/turn-changes.jsx'
import { installSessionInfo } from './native-dsh/session-info.jsx'
import { installReadReceipts } from './native-dsh/read-receipts.jsx'
import { installComposer } from './native-dsh/composer.jsx'

export const inject = ['slots', 'locale']

export function apply(ctx) {
  const controller = new AbortController()
  const catalog = createHistoryCatalog(controller.signal)
  ctx.effect(() => () => controller.abort())

  ctx.slots.provideRoot({ hooks: { codexHistory: catalog.store } })
  installComposer(ctx, catalog.store)
  provideCodexControllers(ctx, catalog)
  installLiveStatus(ctx, catalog.store)
  installMessageSearch(ctx)
  installArchiveView(ctx)
  installTurnChanges(ctx)
  installSessionInfo(ctx)
  installReadReceipts(ctx, catalog)
}
