import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createElement } from 'react'
import { workspaceProjectId } from '../workspaces.js'

const sidebar = 'sidebar.workspaces'
const locale = 'codex.workspace'
const labels = {
  zh: { remove: '将移除项目「{name}」。会话历史和目录文件会保留，会话将按工作目录重新分组。' },
  en: { remove: 'Remove project “{name}”. Session history and files are kept, and sessions are grouped by working directory.' },
}
const projectActions = new Set(['workspace/rename', 'workspace/delete', 'workspace/insertBefore'])

/** 只有 Codex 已登记的项目可以持久化改名、移除与顺序。 */
export function installProjectWorkspaces(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const translate = ctx.locale.bind(locale)
  ctx.inject(['remoteAccess'], scope => scope.effect(() => {
    const access = scope.remoteAccess
    const source = access.source
    const unavailable = createSnapshotStore(false)
    function projectAccess(kind, id, action) {
      if (kind === 'workspace' && projectActions.has(action) && !workspaceProjectId(id)) return unavailable
      return source.call(this, kind, id, action)
    }
    access.source = projectAccess
    return () => { if (access.source === projectAccess) access.source = source }
  }))

  ctx.effect(() => {
    let current
    let restore
    function sync() {
      const entry = ctx.slots.entries(sidebar).find(item => item.locale === 'workspace')
      if (entry === current) return
      restore?.()
      current = entry
      restore = undefined
      const Native = entry?.component
      if (!Native) return
      function WorkspaceBrowser(props) {
        return createElement(Native, { ...props, t: (key, ...args) => key === 'delete.desc' ? translate('remove', ...args) : props.t(key, ...args) })
      }
      entry.component = WorkspaceBrowser
      restore = () => { if (entry.component === WorkspaceBrowser) entry.component = Native }
    }
    const stop = ctx.on('slots/changed', name => { if (name === sidebar) sync() })
    sync()
    return () => { stop(); restore?.() }
  })
}
