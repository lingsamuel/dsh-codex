import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconPinFillRegular, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

const locale = 'codex.archive'
const row = 'sidebar.workspaces.session.row.action'
const menu = 'sidebar.workspaces.session.menu.item'
const trailing = 'sidebar.session.row.trailing'
const overlay = 'shell.overlay'
const labels = {
  zh: {
    archived: '已归档', delete: '永久删除', title: '永久删除会话', cancel: '取消', close: '关闭',
    unarchiveAndRename: '取消归档并改名',
    description: '将永久删除「{title}」及其子代理会话的历史。此操作无法撤销，工作区文件会保留。',
    pending: '正在删除会话…',
  },
  en: {
    archived: 'Archived', delete: 'Permanently delete', title: 'Permanently delete session', cancel: 'Cancel', close: 'Close',
    unarchiveAndRename: 'Unarchive and rename',
    description: 'The history for “{title}” and its subagent conversations will be permanently deleted. This action cannot be undone. Workspace files will be kept.',
    pending: 'Deleting session…',
  },
}

function ArchivedRowNavigation({ useWorkspaces, sessionId, open, t }) {
  const archived = useWorkspaces(state => state.archivedSessionIds.includes(sessionId))
  const anchor = useRef(null)
  const description = t('archived')
  useLayoutEffect(() => {
    if (!archived) return
    const row = anchor.current?.closest('[data-row-key^="session:"]')
    if (!row) return
    const originalDescription = row.getAttribute('aria-description')
    row.setAttribute('aria-description', description)

    function activate(event) {
      if (event.defaultPrevented) return
      // DSH 的行回调会拒绝归档会话。直接用同一个主视图导航打开历史。
      event.preventDefault()
      event.stopPropagation()
      open(sessionId)
    }
    function activateClick(event) {
      if (!event.target.closest?.('button, a, [role="button"]')) activate(event)
    }
    function activateKey(event) {
      if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      activate(event)
    }
    row.addEventListener('click', activateClick)
    row.addEventListener('keydown', activateKey)
    return () => {
      row.removeEventListener('click', activateClick)
      row.removeEventListener('keydown', activateKey)
      if (row.getAttribute('aria-description') !== description) return
      if (originalDescription === null) row.removeAttribute('aria-description')
      else row.setAttribute('aria-description', originalDescription)
    }
  }, [archived, description, open, sessionId])
  return archived && <span hidden ref={anchor} />
}

function preserveArchivedNavigation(navigation, workspaces) {
  const clearArchived = navigation.clearArchivedCurrent
  if (typeof clearArchived !== 'function') return
  const property = Object.getOwnPropertyDescriptor(navigation, 'clearArchivedCurrent')
  let previous = workspaces.getSnapshot().archivedSessionIds

  function reconcileArchived() {
    // DSH 每次清单更新都会检查主视图。保留原生归档时关闭会话的行为，允许继续阅读已经归档的会话。
    const alreadyArchived = previous.includes(this.mainReference?.sessionId)
    previous = workspaces.getSnapshot().archivedSessionIds
    return !alreadyArchived && clearArchived.call(this)
  }

  navigation.clearArchivedCurrent = reconcileArchived
  return () => {
    if (navigation.clearArchivedCurrent !== reconcileArchived) return
    if (property) Object.defineProperty(navigation, 'clearArchivedCurrent', property)
    else Reflect.deleteProperty(navigation, 'clearArchivedCurrent')
  }
}

function ArchivedPinIndicator({ useWorkspaces, sessionId, label }) {
  const active = useWorkspaces(state => state.archivedSessionIds.includes(sessionId) && state.pinnedSessionIds.includes(sessionId))
  return active && <span role="img" aria-label={label()} title={label()}><IconPinFillRegular size={14} /></span>
}

/** 归档置顶沿用原生菜单、权限和线程分组写入。 */
function registerArchivedPinMenu(ctx) {
  const t = ctx.locale.bind('workspace')
  const access = (sessionId, action) => ctx.remoteAccess.source('session', sessionId, `workspace/${action}`)
  ctx.effect(() => ctx.contextMenus.register({
    id: 'codex.archived-pin', target: 'session', order: 100,
    observe: ({ sessionId }) => [ctx.workspaces.list, ctx.locale, access(sessionId, 'pinSession'), access(sessionId, 'unpinSession')],
    resolve({ sessionId }) {
      const { archivedSessionIds, pinnedSessionIds } = ctx.workspaces.list.getSnapshot()
      if (!archivedSessionIds.includes(sessionId)) return []
      const pinned = pinnedSessionIds.includes(sessionId)
      const action = pinned ? 'unpinSession' : 'pinSession'
      if (!access(sessionId, action).getSnapshot()) return []
      return [{
        id: 'pin', label: t(`menu.${action}`), icon: { key: pinned ? 'workspace.unpin' : 'workspace.pin' },
        failureLabel: t(pinned ? 'toast.unpinFailed' : 'toast.pinFailed'),
        run: () => ctx.uiWorkspace[action](sessionId),
      }]
    },
  }))
  ctx.slots.inject(trailing, () => ctx.slots.register({
    name: trailing, id: 'codex-archived-pin-indicator', inject: () => ({ label: () => t('row.pinned') }),
  }, ArchivedPinIndicator))
}

/** 原生改名弹窗负责收集标题。归档时用同一个保存动作确认取消归档。 */
function adaptRenameDialog(ctx) {
  const t = ctx.locale.bind(locale)
  const workspaces = ctx.workspaces.list
  async function renameArchived(sessionId, title) {
    const result = await ctx.sessions.using(sessionId, { source: 'workspaceOperation' },
      reference => reference.binding.session.rename(title, true))
    if (!result.ok) throw new Error(result.error.message)
  }
  let entry
  let restore
  function sync() {
    const next = ctx.slots.entries(overlay).find(item => item.options.id === 'workspace.session-rename')
    if (next === entry) return
    restore?.()
    entry = next
    restore = undefined
    const Native = entry?.component
    if (!Native) return
    function RenameDialog(props) {
      const request = props.useRenameRequest(value => value)
      const { archivedSessionIds } = useSyncExternalStore(workspaces.subscribe, workspaces.getSnapshot)
      if (!request || !archivedSessionIds.includes(request.sessionId)) return <Native {...props} />
      return <Native {...props} renameSession={renameArchived}
        t={(key, ...args) => key === 'rename' || key === 'rename.session.title' ? t('unarchiveAndRename') : props.t(key, ...args)} />
    }
    entry.component = RenameDialog
    restore = () => { if (next.component === RenameDialog) next.component = Native }
  }
  const stop = ctx.slots.subscribe(overlay, sync)
  sync()
  return () => { stop(); restore?.() }
}

function DeleteMenuAction({ useMenuOpenState, sessionId, displayTitle, requestDelete, t }) {
  const [, setOpen] = useMenuOpenState()
  return <MenuItemButton danger icon={<IconTrashOutlineRegular size={14} />} onSelect={() => {
    setOpen(false)
    requestDelete({ sessionId, displayTitle })
  }}>{t('delete')}</MenuItemButton>
}

function DeleteConfirmation({ useDeleteRequest, deleteSession, close, t }) {
  const request = useDeleteRequest(value => value)
  return request && <DeleteDialog key={request.sessionId} request={request} deleteSession={deleteSession} close={close} t={t} />
}

function DeleteDialog({ request, deleteSession, close, t }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setDeleting(true)
    setError('')
    try {
      await deleteSession(request.sessionId)
      close()
    } catch (reason) {
      setError(reason.message)
      setDeleting(false)
    }
  }

  function cancel() {
    if (!deleting) close()
  }

  return <Modal open onClose={cancel} closeLabel={t('close')} title={t('title')} tone="warning"
    description={t('description', { title: request.displayTitle })}
    footer={<>
      <Button variant="outline" data-modal-autofocus disabled={deleting} onClick={cancel}>{t('cancel')}</Button>
      <Button variant="outline" disabled={deleting} onClick={confirm}>{t('delete')}</Button>
    </>}>
    {deleting && <p role="status">{t('pending')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

/** 归档行提供原生导航的直接阅读入口。永久删除须在独立于菜单的弹窗内确认。 */
export function installArchiveView(ctx, deleteSession) {
  const deleteRequest = createSnapshotStore(null)
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['uiWorkspace', 'workspaces'], scope => {
    scope.effect(() => preserveArchivedNavigation(scope.uiWorkspace, scope.workspaces.list))
    const open = id => scope.uiWorkspace.openSession(id)
    scope.slots.inject(row, () => scope.slots.register({
      name: row, id: 'codex-archived-row-navigation', locale,
      inject: () => ({ open }),
    }, ArchivedRowNavigation))
  })
  ctx.inject(['uiWorkspace', 'workspaces', 'contextMenus', 'remoteAccess'], registerArchivedPinMenu)
  ctx.inject(['sessions', 'workspaces'], scope => scope.effect(() => adaptRenameDialog(scope)))
  ctx.slots.inject(menu, () => ctx.slots.register({
    name: menu, id: 'codex-delete-session', order: 500, locale,
    inject: () => ({ requestDelete: request => deleteRequest.set(request) }),
  }, DeleteMenuAction))
  ctx.slots.inject(overlay, () => ctx.slots.register({
    name: overlay, id: 'codex-delete-session-confirm', locale,
    inject: () => ({ hooks: { deleteRequest }, deleteSession, close: () => deleteRequest.set(null) }),
  }, DeleteConfirmation))
}
