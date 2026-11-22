import { createHistoryCatalog } from './catalog.js'
import { provideCodexControllers } from './native-dsh/controllers.js'
import { installLiveStatus } from './native-dsh/live-status.jsx'
import { installMessageSearch } from './native-dsh/message-search.jsx'
import { installArchiveView } from './native-dsh/archive-view.jsx'
import { installTurnChanges } from './native-dsh/turn-changes.jsx'
import { installTurnFork } from './native-dsh/turn-fork.jsx'
import { installTurnRevert } from './native-dsh/turn-revert.jsx'
import { installMessageEdit } from './native-dsh/message-edit.jsx'
import { installCommands } from './native-dsh/commands.jsx'
import { installModelPicker } from './native-dsh/model-picker.js'
import { installReadReceipts } from './native-dsh/read-receipts.jsx'
import { installComposer } from './native-dsh/composer.jsx'
import { installCodexQuestions } from './native-dsh/question-ui.jsx'
import { installCodexApprovals } from './native-dsh/approval-ui.jsx'
import { installVisualizePreview } from './native-dsh/visualize-preview.jsx'
import { installSubagentActivity } from './native-dsh/subagent-activity.jsx'
import { installProjectWorkspaces } from './native-dsh/project-workspaces.js'
import { installFileReferences } from './native-dsh/file-references.js'
import { installPermissions } from './native-dsh/permissions.js'

export const inject = ['slots', 'locale']

export function apply(ctx) {
  const controller = new AbortController()
  const catalog = createHistoryCatalog(controller.signal)
  ctx.effect(() => () => controller.abort())

  ctx.slots.provideRoot({ hooks: { codexHistory: catalog.store } })
  installComposer(ctx, catalog.store)
  const deleteSession = provideCodexControllers(ctx, catalog)
  installProjectWorkspaces(ctx)
  installFileReferences(ctx)
  installPermissions(ctx, catalog.store, controller.signal)
  installCodexQuestions(ctx)
  installCodexApprovals(ctx)
  installLiveStatus(ctx, catalog.store)
  installMessageSearch(ctx)
  installArchiveView(ctx, deleteSession)
  installTurnChanges(ctx)
  installVisualizePreview(ctx)
  installSubagentActivity(ctx, catalog)
  installTurnFork(ctx)
  installTurnRevert(ctx)
  installMessageEdit(ctx)
  installModelPicker(ctx, controller.signal)
  installCommands(ctx)
  installReadReceipts(ctx, catalog)
}
