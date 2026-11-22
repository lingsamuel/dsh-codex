import { Modal, PathLabel, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage } from '../api.js'

function Goal({ goal, t }) {
  if (!goal) return <p>{t('noGoal')}</p>
  return <>
    <p>{goal.objective}</p>
    <p>{t(goal.status)}</p>
    <dl>
      {goal.tokensUsed != null && <><dt>{t('used')}</dt><dd>{goal.tokensUsed.toLocaleString()}</dd></>}
      {goal.tokenBudget != null && <><dt>{t('budget')}</dt><dd>{goal.tokenBudget.toLocaleString()}</dd></>}
    </dl>
  </>
}

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

/** 命令打开时才读取详情。实时目标通知优先于打开时发出的请求。 */
export function CommandDetails({ command, onClose, sessionId, useSession, useSessions, useProjection, t }) {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const liveGoal = useSession(state => state.goal)
  const goalRevision = useSession(state => state.goalRevision)
  const revisionAtOpen = useRef(goalRevision)
  useEffect(() => {
    const abort = new AbortController()
    readPage('thread-info', { threadId: sessionId, view: command }, abort.signal).then(data => {
      if (!abort.signal.aborted) setInfo(data)
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [command, sessionId])
  const goalChanged = goalRevision > revisionAtOpen.current

  return <Modal open title={t(command)} closeLabel={t('close')} onClose={onClose}>
    {error && <p role="alert">{error}</p>}
    {!info && !error && <p role="status">{t('loading')}</p>}
    {command === 'status' && <Status {...{ info, sessionId, useSessions, useProjection, t }} />}
    {command === 'goal' && (info || goalChanged) && <Goal goal={goalChanged ? liveGoal : info?.goal} t={t} />}
    {command === 'ps' && info && <Terminals terminals={info.terminals} t={t} />}
  </Modal>
}
