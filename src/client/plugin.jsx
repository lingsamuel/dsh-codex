import { FileUploadRuntime } from '@deepseek-ai/dsh-client-file-upload/src/client/runtime.ts'
import { createHistoryCatalog } from './catalog.js'
import { provideCodexControllers } from './native-dsh/controllers.js'
import { installLiveStatus } from './native-dsh/live-status.jsx'
import { installMessageSearch } from './native-dsh/message-search.jsx'
import { installArchiveView } from './native-dsh/archive-view.jsx'
import { installTurnChanges } from './native-dsh/turn-changes.jsx'
import { installTurnFork } from './native-dsh/turn-fork.jsx'
import { installForkFeedback } from './native-dsh/fork-feedback.jsx'
import { installTurnRevert } from './native-dsh/turn-revert.jsx'
import { installMessageEdit } from './native-dsh/message-edit.jsx'
import { installFileDownloads } from './native-dsh/file-downloads.jsx'
import { installCommands } from './native-dsh/commands.jsx'
import { installPlanDocuments } from './native-dsh/plan-document.jsx'
import { installModelPicker } from './native-dsh/model-picker.js'
import { installReadReceipts } from './native-dsh/read-receipts.jsx'
import { installComposer } from './native-dsh/composer.jsx'
import { installCodexQuestions } from './native-dsh/question-ui.jsx'
import { installCodexApprovals } from './native-dsh/approval-ui.jsx'
import { installVisualizePreview } from './native-dsh/visualize-preview.jsx'
import { installSubagentActivity } from './native-dsh/subagent-activity.jsx'
import { installProjectWorkspaces } from './native-dsh/project-workspaces.js'
import { installFileReferences } from './native-dsh/file-references.js'
import { installThreadReferences } from './native-dsh/thread-references.jsx'
import { installPermissions } from './native-dsh/permissions.js'
import { installBackgroundTerminals } from './native-dsh/background-terminals.jsx'
import { installCodexSkills } from './native-dsh/skills.js'
import { installCodexCapabilities } from './native-dsh/codex-capabilities.jsx'
import { installCodexMcpInteractions } from './native-dsh/mcp-interaction.jsx'
import { installWorktrees } from './native-dsh/worktree.jsx'
import { installSidebarBrand } from './native-dsh/branding.jsx'

export const inject = ['slots', 'locale']

export function apply(ctx) {
  const controller = new AbortController()
  const catalog = createHistoryCatalog(controller.signal)
  ctx.effect(() => () => controller.abort())

  ctx.slots.provideRoot({ hooks: { codexHistory: catalog.store } })
  // 只加载原生浏览器上传组件。普通文件的服务端入口由 Codex 会话路由持有。
  ctx.plugin(FileUploadRuntime)
  installSidebarBrand(ctx)
  installComposer(ctx, catalog.store)
  const deleteSession = provideCodexControllers(ctx, catalog, installForkFeedback(ctx))
  installProjectWorkspaces(ctx, catalog)
  installFileReferences(ctx, catalog.store)
  installThreadReferences(ctx, catalog, controller.signal)
  installCodexSkills(ctx)
  installCodexCapabilities(ctx)
  installWorktrees(ctx, catalog)
  installPermissions(ctx, catalog.store, controller.signal)
  installCodexQuestions(ctx)
  installCodexApprovals(ctx)
  installCodexMcpInteractions(ctx)
  installLiveStatus(ctx, catalog.store)
  installMessageSearch(ctx)
  installArchiveView(ctx, deleteSession)
  installTurnChanges(ctx)
  installVisualizePreview(ctx)
  installSubagentActivity(ctx, catalog)
  installTurnFork(ctx)
  installTurnRevert(ctx)
  installMessageEdit(ctx)
  installFileDownloads(ctx)
  installModelPicker(ctx, controller.signal)
  installCommands(ctx)
  installPlanDocuments(ctx)
  installBackgroundTerminals(ctx, catalog.backgroundTerminals)
  installReadReceipts(ctx, catalog)
}
