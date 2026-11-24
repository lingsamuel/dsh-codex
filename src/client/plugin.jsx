import { CodexFileUploadRuntime } from './native-dsh/file-upload.js'
import { installCodexFileScope } from './native-dsh/dual-workspace-files.js'
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
import { installWorkspaceLinks } from './native-dsh/workspace-links.jsx'
import { installThreadReferences } from './native-dsh/thread-references.jsx'
import { installPermissions } from './native-dsh/permissions.js'
import { installBackgroundTerminals } from './native-dsh/background-terminals.jsx'
import { installCodexSkills } from './native-dsh/skills.js'
import { installCodexCapabilities } from './native-dsh/codex-capabilities.jsx'
import { installCodexMcpInteractions } from './native-dsh/mcp-interaction.jsx'
import { installWorktrees } from './native-dsh/worktree.jsx'
import { installSidebarBrand } from './native-dsh/branding.jsx'
import { installStartupPage } from './native-dsh/startup.jsx'
import { installTrajectory } from './native-dsh/trajectory.jsx'
import { installWebMode } from './web-mode.jsx'
import { webModePath } from '../shared/web-mode.js'

export const inject = ['slots', 'locale']

export async function apply(ctx) {
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort())
  let mode = globalThis.__DSH_CODEX_WEB_MODE__
  if (!mode) {
    // 官方 Web 可在当前页面热装插件。此时仍使用页面已加载的原生会话控制器。
    const response = await fetch(new URL(webModePath.slice(1) + '?mode=dsh', document.baseURI), {
      signal: controller.signal,
    })
    if (response.ok) mode = await response.json()
  }
  if (controller.signal.aborted) return
  if (mode) {
    installWebMode(ctx, mode)
    if (globalThis.__DSH_CODEX_WEB_MODE__?.mode !== 'codex') return
    installCodexFileScope(ctx)
  }
  const catalog = createHistoryCatalog(controller.signal)
  ctx.slots.provideRoot({ hooks: { codexHistory: catalog.store } })
  // 复用原生上传组件，文件走 Codex 的独立路由。
  ctx.plugin(CodexFileUploadRuntime)
  if (!mode) {
    installSidebarBrand(ctx)
    installCodexFileScope(ctx, false)
  }
  installComposer(ctx, catalog.store)
  const { deleteSession, startupReady } = provideCodexControllers(ctx, catalog, installForkFeedback(ctx))
  installStartupPage(ctx, startupReady)
  installTrajectory(ctx)
  installProjectWorkspaces(ctx, catalog)
  installFileReferences(ctx, catalog.store)
  installWorkspaceLinks(ctx)
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
