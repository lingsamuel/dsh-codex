import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useId, useState } from 'react'
import { CommandButton, CommandModal, commandUnavailable, fieldLayout, textAreaStyle, useCommandAction, useCommandInfo } from './command-action.jsx'

function GoalDetails({ goal, t }) {
  return <>
    <p style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{goal.objective}</p>
    <Pill>{t(goal.status)}</Pill>
    {(goal.tokensUsed != null || goal.tokenBudget != null) && <dl>
      {goal.tokensUsed != null && <><dt>{t('used')}</dt><dd>{goal.tokensUsed.toLocaleString()}</dd></>}
      {goal.tokenBudget != null && <><dt>{t('budget')}</dt><dd>{goal.tokenBudget.toLocaleString()}</dd></>}
    </dl>}
  </>
}

/** 目标管理以原生目标为准，重连后重新读取断线期间的变化。 */
export function GoalCommand({ command, onClose, session, sessionId, useSession, t }) {
  const connected = useSession(state => state.live.mode === 'live' || state.live.mode === 'history')
  const archived = useSession(state => state.archived)
  const captureRevision = useCallback(() => session.getSnapshot().goalRevision, [session])
  const { info, error: readError, revisionAtRead } = useCommandInfo(sessionId, command, connected + ':' + archived, captureRevision)
  const unavailable = useSession(commandUnavailable)
  const liveGoal = useSession(state => state.goal)
  const revision = useSession(state => state.goalRevision)
  // 查询尚在返回时，目标通知或用户提交可能已经更新了会话。
  const hasNewerGoal = revision > (revisionAtRead ?? 0)
  const goal = !info || hasNewerGoal ? liveGoal : info.goal
  const requiresUnarchive = info?.goalRequiresUnarchive && !hasNewerGoal
  const ready = Boolean(info || revision > 0)
  const supported = info?.goalAvailable !== false
  const { pending, error, submit } = useCommandAction(session, archived)
  const [objective, setObjective] = useState('')
  const [budget, setBudget] = useState('')
  const [clearTarget, setClearTarget] = useState(null)
  const confirming = goal && clearTarget && clearTarget.objective === goal.objective && clearTarget.createdAt === goal.createdAt
  const form = useId()
  const tokenBudget = budget ? Number(budget) : undefined
  const validBudget = tokenBudget === undefined || (Number.isSafeInteger(tokenBudget) && tokenBudget > 0)
  const disabled = Boolean(pending || unavailable || !ready || !supported)

  function change(action, parameters) {
    submit({ action, ...parameters }, ({ goal }, before) => {
      // 保存结果与实时通知可能交错，保留请求开始后收到的原生目标。
      session.publishGoal(goal, before.goalRevision)
      setClearTarget(null)
      setObjective('')
      setBudget('')
    })
  }

  function create(event) {
    event.preventDefault()
    if (disabled || !objective.trim() || !validBudget) return
    change('goal-create', { objective: objective.trim(), ...(tokenBudget !== undefined && { tokenBudget }) })
  }

  let footer
  if (requiresUnarchive) {
    footer = <CommandButton action="goal.read" variant="primary" archived {...{ t, disabled }}
      onClick={() => change('goal-unarchive', { unarchive: true })} />
  } else if (ready && supported) {
    if (!goal) {
      footer = <CommandButton type="submit" form={form} action="goal.create" variant="primary" {...{ archived, t }}
        disabled={disabled || !objective.trim() || !validBudget} />
    } else if (confirming) {
      footer = <>
        <Button variant="outline" disabled={pending} onClick={() => setClearTarget(null)}>{t('cancel')}</Button>
        <CommandButton action="goal.clear" variant="outline" {...{ archived, t, disabled }}
          onClick={() => change('goal-clear', { expectedGoal: clearTarget })} />
      </>
    } else {
      const transition = goal.status === 'active' ? 'pause' : goal.status === 'paused' ? 'resume' : undefined
      footer = <>
        <Button variant="outline" disabled={disabled}
          onClick={() => setClearTarget({ objective: goal.objective, createdAt: goal.createdAt })}>{t('goal.clear')}</Button>
        {transition && <CommandButton action={`goal.${transition}`} variant="primary" {...{ archived, t, disabled }}
          onClick={() => change(`goal-${transition}`)} />}
      </>
    }
  }

  return <CommandModal {...{ command, onClose, t, pending, footer }} error={error || readError}
    unavailable={!supported ? 'goalUnavailable' : unavailable ?? (!ready && !readError ? 'loading' : undefined)}>
    {goal && <GoalDetails {...{ goal, t }} />}
    {goal && confirming && <p>{t('goal.confirmClear')}</p>}
    {!goal && ready && supported && !requiresUnarchive && <>
      <p>{t('noGoal')}</p>
      <form id={form} style={{ ...fieldLayout, gap: 10 }} onSubmit={create}>
        <label style={fieldLayout}>
          {t('goal.objective')}
          <textarea rows={3} style={textAreaStyle} value={objective} data-modal-autofocus disabled={pending}
            onChange={event => setObjective(event.target.value)} />
        </label>
        <label style={fieldLayout}>
          {t('goal.optionalBudget')}
          <Input type="number" min={1} step={1} value={budget} disabled={pending} onChange={event => setBudget(event.target.value)} />
        </label>
        {!validBudget && <p role="status">{t('goal.invalidBudget')}</p>}
      </form>
    </>}
  </CommandModal>
}
