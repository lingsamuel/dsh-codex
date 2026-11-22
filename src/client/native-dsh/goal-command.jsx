import { Button, IconCloseOutlineRegular, IconGoalOutlineRegular, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { readPage, writeCommandAction } from '../api.js'
import { observe, remoteFailure } from './catalog.js'
import { commandUnavailable } from './command-action.jsx'
import { adaptSlot } from './slot-adapter.js'

const goalControlsStyle = { display: 'inline-flex', gap: 4, alignItems: 'center', minWidth: 0 }

export function GoalChip({ controls, useInput, useSession, t }) {
  return controls && <GoalInputMode {...{ controls, useInput, useSession, t }} />
}

function GoalInputMode({ controls, useInput, useSession, t }) {
  const { session, focus } = controls
  const { goalDraft } = session
  const draft = useSyncExternalStore(goalDraft.subscribe, goalDraft.getSnapshot)
  const changingPlan = useSession(state => state.planChanging)
  const inputBusy = useInput(state => state.phase !== 'plain')
  const locked = changingPlan || inputBusy
  const [budgetOpen, setBudgetOpen] = useState(false)
  if (!draft) return null
  const budgetLabel = t('goal.optionalBudget')
  return <span style={goalControlsStyle}>
    <Tooltip label={t('goal.exit')} side="top" portal>
      <Button size="sm" variant="outline" icon={<IconGoalOutlineRegular size={14} />} aria-label={t('goal.exit')}
        disabled={locked} onClick={() => { goalDraft.clear(draft); setBudgetOpen(false); focus() }}>
        {t('goal')} <IconCloseOutlineRegular size={12} aria-hidden="true" />
      </Button>
    </Tooltip>
    {budgetOpen ? <Input aria-label={budgetLabel} placeholder={budgetLabel} type="number" inputMode="numeric" min={1} step={1}
      style={{ width: '9em' }} disabled={locked} value={draft.budget}
      onChange={event => goalDraft.set({ budget: event.target.value })} />
      : <Button size="sm" variant="ghost" disabled={locked} onClick={() => setBudgetOpen(true)}>{draft.budget || t('goal.budget')}</Button>}
  </span>
}

/** 替换确认期间由原生发送流程保留草稿，切走会话时取消本次确认。 */
export function GoalReplacement({ useSession, session, t }) {
  const target = useSession(state => state.goalReplacement)
  useEffect(() => () => session.decideGoalReplacement(false), [session])
  if (!target) return null
  const cancel = () => session.decideGoalReplacement(false)
  return <Modal open title={t('goal.replace')} description={t('goal.confirmReplace')} closeLabel={t('close')} onClose={cancel}
    footer={<>
      <Button variant="outline" data-modal-autofocus onClick={cancel}>{t('cancel')}</Button>
      <Button variant="primary" onClick={() => session.decideGoalReplacement(true)}>{t('goal.replace')}</Button>
    </>}>
    <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{target.objective}</p>
  </Modal>
}

function GoalProgress({ Native, goalSession, useSession, commandT, ...props }) {
  const session = goalSession
  const connected = useSession(state => state.live.mode === 'live' || state.live.mode === 'history')
  const archived = useSession(state => state.archived)
  const readonly = useSession(commandUnavailable)
  const goal = useSession(state => state.goal)
  const revision = useSession(state => state.goalRevision)

  useEffect(() => {
    if (!connected || archived || readonly) return
    const controller = new AbortController()
    const { goalRevision } = session.getSnapshot()
    void readPage('thread-info', { threadId: session.sessionId, view: 'goal' }, controller.signal).then(info => {
      if (!controller.signal.aborted && !info.goalRequiresUnarchive && info.goalAvailable !== false) session.publishGoal(info.goal, goalRevision)
    }).catch(() => {})
    return () => controller.abort()
  }, [session, connected, archived, readonly])

  if (!goal || goal.status === 'complete' || archived || readonly) return null

  async function change(action, objective) {
    if (session.getSnapshot().goalRevision !== revision) return { ok: false, error: remoteFailure('目标已变化，请重新操作。') }
    try {
      const result = await writeCommandAction({ threadId: session.sessionId, action, objective,
        expectedGoal: { objective: goal.objective, createdAt: goal.createdAt } })
      session.publishGoal(result.goal, revision)
      if (action === 'goal-resume' && result.goal?.status !== 'active') {
        const message = result.goal?.status === 'budgetLimited' ? 'goal.resumeBudget' : 'goal.resumeBlocked'
        return { ok: false, error: remoteFailure(commandT(message)) }
      }
      return { ok: true, value: result.goal }
    } catch (error) {
      return { ok: false, error: remoteFailure(error.message) }
    }
  }

  const budget = [goal.tokensUsed != null && `${commandT('used')} ${goal.tokensUsed.toLocaleString()}`,
    goal.tokenBudget != null && `${commandT('budget')} ${goal.tokenBudget.toLocaleString()}`].filter(Boolean).join(' · ')
  return <div title={budget || undefined}>
    <Native {...props} useSession={useSession} onEdit={text => change('goal-edit', text)}
      onPause={() => change('goal-pause')} onResume={() => change('goal-resume')} onClear={() => change('goal-clear')} />
  </div>
}

/** 复用 ui-goal 注册的原生 GoalDock。状态和写操作直接来自当前 Codex 会话。 */
export function installGoalBar(ctx, t) {
  ctx.inject(['sessions'], scope => adaptSlot(scope, 'conversation.input.dock', entry => entry.options.id === 'goal', (_, Native) => ({
    inject(sessionId) {
      const { session } = scope.sessions.binding(sessionId)
      const goalActivation = observe(session.projections.faceOf('goal'), projection => {
        const goal = projection?.goal
        return goal?.phase === 'active' ? { id: goal.id, revision: goal.revision, activation: 'armed' } : {}
      })
      return { goalSession: session, hooks: { goalActivation } }
    },
    component: props => <GoalProgress {...props} Native={Native} commandT={t} />,
  })))
}
