import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconCloseOutlineRegular, IconPlanOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import { writeCommandAction } from '../api.js'
import { commandUnavailable } from './command-action.jsx'
import { ComposerModeLabel } from './composer-mode-label.jsx'

const rowStyle = { display: 'inline-flex', alignItems: 'center', gap: 4 }

/** 命令与标签共用同一设置请求，只以 Codex 的确认更新模式。 */
export function createPlanAction(ctx, session) {
  const store = createSnapshotStore(null)

  function confirm(mode, goal) {
    if (mode === 'plan') session.goalDraft.clear(goal)
    store.set(null)
  }

  ctx.effect(() => session.subscribe(() => {
    const change = store.getSnapshot()
    if (change?.waitingAt !== undefined && session.getSnapshot().planMode === change.mode) confirm(change.mode, change.goal)
  }))

  async function select(mode, archived) {
    if (store.getSnapshot()?.pending) return false
    const { planRevision: revision } = session.getSnapshot()
    const goal = session.goalDraft.getSnapshot()
    session.setPlanChanging(true)
    store.set({ pending: true })
    try {
      const result = await writeCommandAction({ threadId: session.sessionId, action: 'plan', mode, ...(archived && { unarchive: true }) })
      if (result.confirmed) {
        session.publishPlanMode(result.mode, revision)
        if (session.getSnapshot().planMode === mode) confirm(mode, goal)
        else store.set(null)
      } else if (session.getSnapshot().planMode === mode) confirm(mode, goal)
      else store.set({ waitingAt: revision, mode, goal })
      return session.getSnapshot().planMode === mode
    } catch (failure) {
      store.set({ error: failure.message })
      return false
    } finally {
      session.setPlanChanging(false)
    }
  }

  return { ...store, select, request(mode) {
    const state = session.getSnapshot()
    if (commandUnavailable(state) || store.getSnapshot()?.pending) return
    if (state.archived) store.set({ archivedMode: mode })
    else void select(mode, false)
  }, dismiss: () => store.set(null) }
}

export function PlanChip({ controls, locked, useSession, useInput, t }) {
  const { planAction, focus, session: { goalDraft } } = controls
  const mode = useSession(state => state.planMode)
  const revision = useSession(state => state.planRevision)
  const unavailable = useSession(commandUnavailable)
  const change = useSyncExternalStore(planAction.subscribe, planAction.getSnapshot)
  const draft = useSyncExternalStore(goalDraft.subscribe, goalDraft.getSnapshot)
  const inputBusy = useInput(state => state.phase !== 'plain')
  const { pending, error, waitingAt, archivedMode } = change ?? {}
  const waiting = waitingAt === revision
  const showPlan = mode === 'plan' && !draft
  if (!showPlan && !pending && !waiting && !error && !archivedMode) return null

  const exit = t('plan.exit')
  return <span style={rowStyle}>
    {archivedMode ? <>
      <Button size="sm" variant="outline" disabled={Boolean(unavailable || inputBusy)} onClick={() => planAction.select(archivedMode, true)}>
        {t(archivedMode === 'plan' ? 'plan.enter.unarchive' : 'plan.exit.unarchive')}
      </Button>
      <Button size="sm" variant="ghost" aria-label={t('cancel')} onClick={() => { planAction.dismiss(); focus() }}>
        <IconCloseOutlineRegular size={12} />
      </Button>
    </> : showPlan && <ComposerModeLabel label={t('plan')} exitLabel={exit} icon={<IconPlanOutlineRegular size={14} />}
      disabled={Boolean(unavailable || pending || locked || inputBusy)} onExit={() => { planAction.request('default'); focus() }} />}
    {pending && <span role="status">{t('pending')}</span>}
    {waiting && <span role="status">{t('awaitingMode')}</span>}
    {error && <Tooltip label={error} side="top" portal>
      <span role="alert" title={error} style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{t('plan.changeFailed')}</span>
    </Tooltip>}
  </span>
}
