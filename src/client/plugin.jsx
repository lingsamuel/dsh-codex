import { createHistoryCatalog } from './catalog.js'
import { History, Sidebar, SidebarToggle, threadTitle } from './history.jsx'
import styles from './styles.css'

export const inject = ['slots', 'layout']

export function apply(ctx) {
  // DSH 根视图总会读取可选的 Session scope。空绑定满足渲染契约，聊天直接读取 Codex。
  const absentSession = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const sessionSource = {
    getSnapshot: () => absentSession,
    subscribe: () => () => {},
  }
  ctx.slots.installScope('session', { current: sessionSource, bindingSource: () => sessionSource })

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  })
  const controller = new AbortController()
  const catalog = createHistoryCatalog(controller.signal)
  ctx.effect(() => () => controller.abort())

  // 原生 AppFrame 只用 sessions hook 决定浏览器标题。
  let selectedThread = null
  let titleSnapshot = { byId: {} }
  const sessions = {
    subscribe: catalog.store.subscribe,
    getSnapshot: () => {
      const { selected } = catalog.store.getSnapshot()
      if (selected !== selectedThread) {
        selectedThread = selected
        titleSnapshot = { byId: selected
          ? { [selected.id]: { id: selected.id, title: threadTitle(selected), retainedBy: { mainView: 1 } } }
          : {} }
      }
      return titleSnapshot
    },
  }
  ctx.slots.provideRoot({ hooks: { codexHistory: catalog.store, sessions } })
  const toggle = () => ctx.layout.toggleSidebar()
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    inject: () => ({ catalog, toggle }),
  }, Sidebar))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'conversation' }, History))
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    inject: () => ({ toggle, collapsed: true }),
  }, SidebarToggle))
}
