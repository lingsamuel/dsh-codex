import { Button, IconFolderOpenOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'

const locale = 'codex.archive'
const row = 'sidebar.workspaces.session.row.action'
const menu = 'sidebar.workspaces.session.menu.item'
const labels = { zh: { open: '查看归档会话' }, en: { open: 'View archived session' } }

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

/** DSH 的归档行默认提示恢复。单独提供直接阅读入口仍使用原生会话导航。 */
export function installArchiveView(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['uiWorkspace'], scope => {
    for (const [name, View] of [[row, ArchiveRowAction], [menu, ArchiveMenuAction]]) {
      scope.slots.inject(name, () => scope.slots.register({
        name, id: 'codex-view-archive', order: 50, locale,
        inject: () => ({ open: id => scope.uiWorkspace.openSession(id) }),
      }, View))
    }
  })
}
