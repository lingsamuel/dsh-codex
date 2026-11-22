import { Input, PathLabel, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useState } from 'react'
import { CommandButton, CommandModal, commandUnavailable, fieldLayout, textAreaStyle, useCommandAction, useCommandInfo } from './command-action.jsx'
import { GoalCommand } from './goal-command.jsx'
import { PlanCommand } from './plan-command.jsx'
import { ExportCommand } from './session-export.jsx'

const reviewValues = { uncommittedChanges: null, baseBranch: 'branch', commit: 'sha', custom: 'instructions' }
const reviewChoice = { display: 'flex', alignItems: 'center', gap: 8 }

function Terminals({ terminals, t }) {
  if (!terminals) return <p>{t('terminalsUnavailable')}</p>
  if (terminals.length === 0) return <p>{t('noTerminals')}</p>
  return <ul>{terminals.map(terminal => <li key={terminal.processId}>
    <code>{terminal.command}</code>{terminal.cwd && <>{' '}<PathLabel path={terminal.cwd} /></>}
  </li>)}</ul>
}

function Status({ info, sessionId, useSessions, useProjection, t }) {
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const usage = useProjection('contextPressure')
  return <dl>
    <dt>{t('session')}</dt><dd><code>{sessionId}</code></dd>
    {cwd && <><dt>{t('cwd')}</dt><dd><PathLabel path={cwd} /></dd></>}
    {info?.model && <><dt>{t('model')}</dt><dd>{info.model}</dd></>}
    {info?.reasoningEffort && <><dt>{t('effort')}</dt><dd>{info.reasoningEffort}</dd></>}
    {usage && <><dt>{t('context')}</dt><dd>
      <Pill>{Math.min(100, Math.round(usage.pressureTokens / usage.contextWindow * 100))}%</Pill>
      {' '}{usage.pressureTokens.toLocaleString()} / {usage.contextWindow.toLocaleString()} tokens
    </dd></>}
  </dl>
}

function ReadOnlyCommand({ command, onClose, sessionId, useSessions, useProjection, t }) {
  const { info, error } = useCommandInfo(sessionId, command)
  return <CommandModal {...{ command, onClose, t, error }} unavailable={!info && !error ? 'loading' : undefined}>
    {command === 'status' && <Status {...{ info, sessionId, useSessions, useProjection, t }} />}
    {command === 'ps' && info && <Terminals terminals={info.terminals} t={t} />}
  </CommandModal>
}

function turnUnavailable(state) {
  return commandUnavailable(state) ?? (state.live.status?.type === 'active' || state.running ? 'busy' : undefined)
}

function CompactCommand({ command, onClose, session, useSession, t }) {
  const unavailable = useSession(state => turnUnavailable(state) ?? (state.blank ? 'blank' : undefined))
  const archived = useSession(state => state.archived)
  const { error, pending, submit } = useCommandAction(session, archived)
  return <CommandModal {...{ command, onClose, t, error, pending, unavailable }} description={t('compact.detail')}
    footer={<CommandButton action="compact.run" variant="primary" {...{ archived, t }} disabled={Boolean(unavailable || pending)}
      onClick={() => submit({ action: 'compact' }, onClose)} />} />
}

function ReviewCommand({ command, onClose, session, useSession, t }) {
  const unavailable = useSession(turnUnavailable)
  const archived = useSession(state => state.archived)
  const { error, pending, submit } = useCommandAction(session, archived)
  const [target, setTarget] = useState('uncommittedChanges')
  const [values, setValues] = useState({})
  const form = useId()
  const field = reviewValues[target]
  const value = values[target] ?? ''
  const disabled = Boolean(unavailable || pending || (field && !value.trim()))
  function review(event) {
    event.preventDefault()
    if (disabled) return
    submit({ action: 'review', target: { type: target, ...(field && { [field]: value.trim() }) } }, onClose)
  }
  const setValue = event => setValues({ ...values, [target]: event.target.value })

  return <CommandModal {...{ command, onClose, t, error, pending, unavailable }} description={t('review.detail')}
    footer={<CommandButton type="submit" form={form} action="review.run" variant="primary" {...{ archived, t, disabled }} />}>
    <form id={form} style={{ ...fieldLayout, gap: 12 }} onSubmit={review}>
      <div role="radiogroup" aria-label={t('review.target')} style={fieldLayout}>
        {Object.keys(reviewValues).map(type => <label key={type} style={reviewChoice}>
          <input type="radio" name={form} checked={target === type} disabled={pending}
            onChange={() => setTarget(type)} data-modal-autofocus={type === 'uncommittedChanges' ? '' : undefined} />
          {t(`review.${type}`)}
        </label>)}
      </div>
      {field && <label style={fieldLayout}>
        {t(`review.${field}`)}
        {target === 'custom'
          ? <textarea rows={3} style={textAreaStyle} {...{ value }} onChange={setValue} disabled={pending} />
          : <Input key={field} {...{ value }} onChange={setValue} disabled={pending} />}
      </label>}
    </form>
  </CommandModal>
}

/** 在原生输入栏弹层中按命令类型挂载对应表单，表单状态随这次打开保留。 */
export function CommandDetails(props) {
  switch (props.command) {
    case 'export': return <ExportCommand {...props} />
    case 'compact': return <CompactCommand {...props} />
    case 'review': return <ReviewCommand {...props} />
    case 'plan': return <PlanCommand {...props} />
    case 'goal': return <GoalCommand {...props} />
    default: return <ReadOnlyCommand {...props} />
  }
}
