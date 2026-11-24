import { isLocalSessionId, worktreeSelection } from '../../shared/local-session.js'
import { codexTerminalDescriptors, codexTerminalNamespace, encodeTerminalScope } from '../../shared/sidebar-terminals.js'
import { replaceMethod } from './replace-method.js'

const launchMethods = new Set(['environment', 'shells', 'create'])

/** 原生终端界面继续持有自己的模型，只有 Codex 页面把它的请求导向 Codex Host。 */
export function installSidebarTerminals(ctx) {
  const handoffs = new Map()
  ctx.inject(['remote', 'remote.terminal', 'typert'], async scope => {
    const native = scope.remote.terminal
    const descriptors = codexTerminalDescriptors(scope.typert.remotes.list())
    if (!descriptors.length) return
    const mounted = scope.remote.$mount({ package: 'dsh-for-codex-terminal', descriptors })
    const namespace = 'remote.' + codexTerminalNamespace
    // 原生模型在挂载时也会重试之前没有收到回执的关闭操作。
    const restoreClose = replaceMethod(native, 'close', async (...args) => {
      await mounted
      return scope.get(namespace).close(...args)
    })
    let unmount
    try {
      unmount = await mounted
    } catch (error) {
      restoreClose()
      throw error
    }
    const terminal = scope.get(namespace)
    const restore = descriptors.filter(({ method }) => method !== 'close').map(({ method }) =>
      replaceMethod(native, method, (id, ...args) => {
        if (!launchMethods.has(method) || !isLocalSessionId(id)) return terminal[method](id, ...args)
        const sessions = scope.get('sessions')
        const draft = sessions?.list.getSnapshot().byId[id]
        const choice = draft && sessions.binding(id)?.session?.worktreeDraft?.getSnapshot()
        const address = handoffs.get(id) ?? (draft ? encodeTerminalScope(id, draft.cwd, worktreeSelection(choice)) : id)
        return terminal[method](address, ...args)
      }))
    scope.effect(() => async () => {
      restoreClose()
      restore.forEach(dispose => dispose())
      await unmount()
    })
  })

  return async (draftId, { id: threadId, cwd }) => {
    const sidebar = ctx.get('sidebarRight')
    const terminals = ctx.get('webTerminals')
    if (!sidebar || !terminals) return
    const tabs = sidebar.tabsIn(draftId).filter(tab => tab.kind === 'terminal')
    if (!tabs.length) return
    const store = ctx.slots.entriesOfSlot('rightbar.session')[0]?.store
    if (!store) return
    const draft = store.create(draftId)
    store.create(threadId)
    const sessions = ctx.get('sessions')
    const source = sessions?.list.getSnapshot().byId[draftId]
    const choice = sessions?.binding(draftId)?.session?.worktreeDraft?.getSnapshot()
    // 首发已消费所提交的 Worktree 选择。仍在启动的终端可以用回执目录继续。
    handoffs.set(draftId, choice && source ? encodeTerminalScope(draftId, source.cwd, worktreeSelection(choice))
      : encodeTerminalScope(draftId, cwd))
    try {
      await Promise.all(tabs.map(async tab => {
        const params = sidebar.tabDomain.occurrence(draftId, tab).navigation.getSnapshot().params
        const view = terminals.view(draftId, tab.id, tab.contentId, params?.terminalId, params?.shellPath)
        if (!view.state.getSnapshot().info) await view.refresh()
        if (!sidebar.tabsIn(draftId).some(current => current.id === tab.id)) return
        const terminalId = view.state.getSnapshot().info?.id
        if (!terminalId) return
        const target = sidebar.tabsIn(threadId)
        if (!target.some(current => terminals.boundTerminal(threadId, current.contentId) === terminalId)) {
          const before = new Set(target.map(current => current.id))
          sidebar.openTabIn(threadId, 'terminal', { params: { terminalId } })
          const opened = sidebar.tabsIn(threadId).find(current => current.kind === 'terminal' && !before.has(current.id))
          if (!opened) return
          terminals.bind(threadId, opened.contentId, terminalId)
        }
        // 直接移除旧标签布局。走关闭终端的处理函数会结束刚接续的进程。
        draft.actions.closeTab(draftId, tab.id)
        await view.dispose()
      }))
    } finally {
      handoffs.delete(draftId)
    }
  }
}
