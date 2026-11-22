import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconFolderOpenOutlineRegular, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

const locale = 'codex.archive'
const row = 'sidebar.workspaces.session.row.action'
const menu = 'sidebar.workspaces.session.menu.item'
const overlay = 'shell.overlay'
const labels = {
  zh: {
    open: '查看归档会话', delete: '永久删除', title: '永久删除会话', cancel: '取消', close: '关闭',
    description: '将永久删除「{title}」及其子代理会话的历史。此操作无法撤销，工作区文件会保留。',
    pending: '正在删除会话…',
  },
  en: {
    open: 'View archived session', delete: 'Permanently delete', title: 'Permanently delete session', cancel: 'Cancel', close: 'Close',
    description: 'The history for “{title}” and its subagent conversations will be permanently deleted. This action cannot be undone. Workspace files will be kept.',
    pending: 'Deleting session…',
  },
}

function ArchiveRowAction({ useWorkspaces, sessionId, open, t }) {
  const archived = useWorkspaces(state => state.archivedSessionIds.includes(sessionId))
  if (!archived) return null
  return <Button size="sm" variant="toolbar" aria-label={t('open')} title={t('open')}
    icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => open(sessionId)} />
}

function ArchiveMenuAction({ useWorkspaces, useMenuOpenState, sessionId, open, t }) {
  const archived = useWorkspaces(state => state.archivedSessionIds.includes(sessionId))
  const [, setOpen] = useMenuOpenState()
  if (!archived) return null
  return <MenuItemButton icon={<IconFolderOpenOutlineRegular size={14} />} onSelect={() => {
    setOpen(false)
    open(sessionId)
  }}>{t('open')}</MenuItemButton>
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
    for (const [name, View] of [[row, ArchiveRowAction], [menu, ArchiveMenuAction]]) {
      scope.slots.inject(name, () => scope.slots.register({
        name, id: 'codex-view-archive', order: 50, locale,
        inject: () => ({ open: id => scope.uiWorkspace.openSession(id) }),
      }, View))
    }
  })
  ctx.slots.inject(menu, () => ctx.slots.register({
    name: menu, id: 'codex-delete-session', order: 500, locale,
    inject: () => ({ requestDelete: request => deleteRequest.set(request) }),
  }, DeleteMenuAction))
  ctx.slots.inject(overlay, () => ctx.slots.register({
    name: overlay, id: 'codex-delete-session-confirm', locale,
    inject: () => ({ hooks: { deleteRequest }, deleteSession, close: () => deleteRequest.set(null) }),
  }, DeleteConfirmation))
}
