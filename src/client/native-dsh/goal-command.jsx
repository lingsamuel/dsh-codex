import { Button, IconGoalOutlineRegular, IconWarningOutlineRegular, Input, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { writeCommandAction } from '../api.js'
import { observe, remoteFailure } from './catalog.js'
import { CommandModal, commandUnavailable, fieldLayout } from './command-action.jsx'
import { adaptSlot } from './slot-adapter.js'
import { ComposerModeLabel } from './composer-mode-label.jsx'

export function GoalChip({ controls, useInput, useSession, t }) {
  const { session, focus } = controls
  const { goalDraft } = session
  const draft = useSyncExternalStore(goalDraft.subscribe, goalDraft.getSnapshot)
  const changingPlan = useSession(state => state.planChanging)
  const error = useSession(state => state.goalError)
  const inputBusy = useInput(state => state.phase !== 'plain')
  const label = useRef(null)
  if (!draft) return null
  return <span ref={label} style={{ display: 'inline-flex' }}>
    <ComposerModeLabel label={t('goal')} exitLabel={t('goal.exit')} icon={<IconGoalOutlineRegular size={14} />}
      disabled={Boolean(changingPlan || inputBusy)} onExit={() => { goalDraft.clear(draft); focus() }} />
    {error && !inputBusy && <Toast text={error.message} icon={<IconWarningOutlineRegular />}
      anchor={label.current?.closest('[data-composer-card]')} onDone={() => session.dismissGoalError(error)} />}
  </span>
}

export function GoalBudget({ command, session, onClose, t }) {
  const { goalDraft } = session
  const [budget, setBudget] = useState(() => goalDraft.getSnapshot()?.budget ?? '')
  const form = useId()
  const amount = budget.trim()
  const invalid = Boolean(amount) && (!Number.isSafeInteger(Number(amount)) || Number(amount) < 1)

  function save(event) {
    event.preventDefault()
    if (invalid) return
    if (goalDraft.getSnapshot()) goalDraft.set({ budget: amount })
    onClose()
  }

  return <CommandModal {...{ command, onClose, t }} footer={<>
    <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
    <Button type="submit" form={form} variant="primary" disabled={invalid}>{t('goal.saveBudget')}</Button>
  </>}>
    <form id={form} onSubmit={save} style={fieldLayout}>
      <label style={fieldLayout}>
        {t('goal.optionalBudget')}
        <Input inputMode="numeric" value={budget} data-modal-autofocus aria-invalid={invalid || undefined}
          onChange={event => setBudget(event.currentTarget.value)} />
      </label>
      {invalid && <span role="status">{t('goal.invalidBudget')}</span>}
    </form>
  </CommandModal>
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
  const archived = useSession(state => state.archived)
  const readonly = useSession(commandUnavailable)
  const goal = useSession(state => state.goal)
  const revision = useSession(state => state.goalRevision)

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
