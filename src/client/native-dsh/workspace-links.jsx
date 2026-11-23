import { childPath } from '@deepseek-ai/dsh-client-ui-sidebar-files/src/client/store.ts'
import { useEffect, useRef } from 'react'
import { adaptSlot } from './slot-adapter.js'

const filesSlot = 'sidebar.right.pane.tab'
const filesEntry = '@deepseek-ai/dsh-client-ui-sidebar-files'

function DirectoryReveal({ useTabInfo, useStore, setQuery, toggle, page }) {
  const { panel, tab } = useTabInfo()
  const { revision, params } = tab.navigation
  const directory = params?.directoryPath
  const state = useStore(store => typeof directory === 'string' ? store.byPane[panel.id] : undefined)
  const revealed = useRef()

  useEffect(() => {
    const tree = state?.tree
    if (!tab.visible || !tree || typeof directory !== 'string' || revealed.current === revision) return
    if (state.query.trim()) {
      setQuery(panel.id, tree.root, '')
      return
    }

    // 使用宿主返回的工作区相对路径。每次只展开一个已列出的层级，下一层由原生树加载。
    let parent = tree.root
    for (const name of directory ? directory.split('/') : []) {
      const level = tree.levels[parent]
      if (level?.kind !== 'ready' || !level.level.entries.some(entry => entry.type === 'directory' && entry.name === name)) return
      const path = childPath(parent, name)
      if (!tree.expanded.includes(path)) {
        toggle(panel.id, parent, path, tree.expanded)
        return
      }
      parent = path
    }
    revealed.current = revision
    const row = directory && page.current?.querySelector(`[data-files-entry="directory"][data-files-path="${CSS.escape(parent)}"]`)
    if (row) row.querySelector('button')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [directory, page, panel.id, revision, setQuery, state, tab.visible, toggle])

  return null
}

/** 复用 DSH 的链接解析和工作区目录权限，目录请求交给会话自己的 Files 页。 */
export function installWorkspaceLinks(ctx) {
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'], scope => {
    let pending
    scope.effect(() => () => pending?.abort())

    adaptSlot(scope, 'conversation.view', entry => entry.options.id === 'chat', (inject, Native) => ({
      inject(sessionId, ...args) {
        const chat = inject(sessionId, ...args)
        return {
          ...chat,
          async openFile(path, options) {
            pending?.abort()
            const request = new AbortController()
            pending = request
            const { sidebarRight, sidebarRightTabs, remote } = scope
            try {
              const listing = sidebarRightTabs.get('files') &&
                await remote.workspaceFiles.list(sessionId, chat.resolveFilePath(path), request.signal)
              if (request.signal.aborted || sidebarRight.mounted.getSnapshot() !== sessionId) return
              if (listing?.ok) sidebarRight.openTab('files', { params: { directoryPath: listing.value.path } })
              else await chat.openFile(path, options)
            } finally {
              if (pending === request) pending = undefined
            }
          },
        }
      },
      component: Native,
    }))

    adaptSlot(scope, filesSlot, entry => entry.options.key === filesEntry, (inject, Native) => ({
      inject,
      component: function FilesWithDirectoryLink(props) {
        const page = useRef(null)
        return <div ref={page} style={{ display: 'contents' }}>
          <Native {...props} />
          <DirectoryReveal {...props} page={page} />
        </div>
      },
    }))
  })
}
