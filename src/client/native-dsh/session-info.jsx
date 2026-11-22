import { Button, IconInfoOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage } from '../api.js'

const slot = 'conversation.session.header.utilities'
const locale = 'codex.session.info'
const copy = {
  zh: { title: 'Codex 会话详情', close: '关闭', loading: '正在读取…', model: '模型', effort: '推理强度', goal: '目标',
    used: '已使用 token', budget: 'token 预算', empty: '此会话没有可显示的详情。', active: '进行中', paused: '暂停',
    blocked: '受阻', usageLimited: '达到用量限制', budgetLimited: '达到预算', complete: '已完成' },
  en: { title: 'Codex session details', close: 'Close', loading: 'Loading…', model: 'Model', effort: 'Reasoning effort', goal: 'Goal',
    used: 'Tokens used', budget: 'Token budget', empty: 'No details are available for this session.', active: 'Active', paused: 'Paused',
    blocked: 'Blocked', usageLimited: 'Usage limited', budgetLimited: 'Budget limited', complete: 'Complete' },
}

function Goal({ goal, t }) {
  return <section>
    <h3>{t('goal')}</h3>
    <p>{goal.objective}</p>
    <p>{t(goal.status)}</p>
    <dl>
      {goal.tokensUsed != null && <><dt>{t('used')}</dt><dd>{goal.tokensUsed.toLocaleString()}</dd></>}
      {goal.tokenBudget != null && <><dt>{t('budget')}</dt><dd>{goal.tokenBudget.toLocaleString()}</dd></>}
    </dl>
  </section>
}

function SessionInfo({ sessionId, useSession, t }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const liveGoal = useSession(state => state.goal)
  const goalRevision = useSession(state => state.goalRevision)
  const revisionAtOpen = useRef(0)
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    readPage('thread-info', { threadId: sessionId }, abort.signal).then(data => {
      if (!abort.signal.aborted) setInfo(data)
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [open, sessionId])
  const goal = goalRevision > revisionAtOpen.current ? liveGoal : info?.goal

  return <>
    <Button size="sm" variant="toolbar" aria-label={t('title')} title={t('title')}
      icon={<IconInfoOutlineRegular size={16} />} onClick={() => {
        revisionAtOpen.current = goalRevision
        setInfo(null)
        setError('')
        setOpen(true)
      }} />
    <Modal open={open} title={t('title')} closeLabel={t('close')} onClose={() => setOpen(false)}>
      {error && <p role="alert">{error}</p>}
      {!info && !error && <p role="status">{t('loading')}</p>}
      {(info?.model || info?.reasoningEffort) && <dl>
        {info.model && <><dt>{t('model')}</dt><dd>{info.model}</dd></>}
        {info.reasoningEffort && <><dt>{t('effort')}</dt><dd>{info.reasoningEffort}</dd></>}
      </dl>}
      {goal && <Goal goal={goal} t={t} />}
      {info && !info.model && !info.reasoningEffort && !goal && <p>{t('empty')}</p>}
    </Modal>
  </>
}

/** 详情只在打开时查询，活动目标的原生通知可直接更新弹窗。 */
export function installSessionInfo(ctx) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'codex-session-info', order: 30, locale }, SessionInfo))
}
