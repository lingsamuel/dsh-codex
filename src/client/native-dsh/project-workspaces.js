import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ICON_SYMBOLS, IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceProjectId } from '../workspaces.js'
import { renderArchiveSearch } from './archive-search.js'
import { renderArchiveOrder } from './archive-order.js'

const sidebar = 'sidebar.workspaces'
const locale = 'codex.workspace'
const labels = {
  zh: {
    remove: '将移除项目「{name}」。会话历史和目录文件会保留，会话将按工作目录重新分组。',
    promote: '转为项目', promoting: '正在转换目录分组…', retry: '重试',
    moved: '已转为项目，迁移了 {count} 条会话。',
    partial: '已迁移 {moved} 条会话，{failed} 条失败。', failure: '无法转换目录分组。',
  },
  en: {
    remove: 'Remove project “{name}”. Session history and files are kept, and sessions are grouped by working directory.',
    promote: 'Convert to project', promoting: 'Converting the directory group…', retry: 'Retry',
    moved: 'Converted to a project and moved {count} conversations.',
    partial: 'Moved {moved} conversations. {failed} failed.', failure: 'Could not convert the directory group.',
  },
}
const projectActions = new Set(['workspace/rename', 'workspace/delete', 'workspace/insertBefore'])
const projectIcon = 'codex.workspace.project'

function installProjectIcons(ctx) {
  ctx.effect(() => {
    // 原生行把文件夹写在首个图标位。使用 DSH 的独立 SVG 图稿，让蒙版继承原生颜色和悬停行为。
    const icon = ICON_SYMBOLS['dsw-icon-workspace-tree-outline-regular']
    const style = document.createElement('style')
    const slot = '[data-row-key^="workspace:project:"] > span:first-child'
    style.textContent = `${slot} > svg { display: none; }
      ${slot}::before { content: ''; width: 16px; height: 16px; background: currentColor;
        mask: url("data:image/svg+xml,${encodeURIComponent(icon)}") center / contain no-repeat; }`
    document.head.append(style)
    return () => style.remove()
  })
}

function installDirectoryPromotion(ctx, catalog, t) {
  ctx.inject(['contextMenus', 'remoteAccess'], scope => {
    const { contextMenus } = scope
    const pending = new Set()
    async function promote(cwd) {
      if (pending.has(cwd)) return
      pending.add(cwd)
      contextMenus.notify(t('promoting'))
      const retry = { label: t('retry'), run: () => promote(cwd), failureLabel: t('failure') }
      try {
        const { moved, failed } = await catalog.updateProject({ action: 'promote', cwd })
        if (failed.length) contextMenus.notify(t('partial', { moved: moved.length, failed: failed.length }), false, retry)
        else contextMenus.notify(t('moved', { count: moved.length }), true)
      } catch (error) {
        contextMenus.notify(error.message || t('failure'), false, retry)
      } finally {
        pending.delete(cwd)
      }
    }
    scope.slots.inject('contextMenu.icon', () => scope.slots.register({ name: 'contextMenu.icon', key: projectIcon }, IconWorkspaceTreeOutlineRegular))
    scope.effect(() => contextMenus.register({
      id: 'codex.promote-directory', target: 'workspace', order: 100,
      resolve({ workspaceId, path }) {
        if (!workspaceId.startsWith('directory:') || !scope.remoteAccess.source('workspace', workspaceId, 'session/create').getSnapshot()) return []
        return [{ id: 'promote', label: t('promote'), icon: { key: projectIcon }, disabled: pending.has(path), run: () => promote(path) }]
      },
    }))
  })
}

/** 只有 Codex 已登记的项目可以持久化改名、移除与顺序。 */
export function installProjectWorkspaces(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const translate = ctx.locale.bind(locale)
  installDirectoryPromotion(ctx, catalog, translate)
  installProjectIcons(ctx)
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
        return renderArchiveOrder(renderArchiveSearch(Native, {
          ...props, t: (key, ...args) => key === 'delete.desc' ? translate('remove', ...args) : props.t(key, ...args),
        }, catalog.search))
      }
      entry.component = WorkspaceBrowser
      restore = () => { if (entry.component === WorkspaceBrowser) entry.component = Native }
    }
    const stop = ctx.on('slots/changed', name => { if (name === sidebar) sync() })
    sync()
    return () => { stop(); restore?.() }
  })
}
