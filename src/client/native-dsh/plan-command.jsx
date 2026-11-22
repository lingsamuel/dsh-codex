import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconCloseCircleFillRegular, IconPlanOutlineRegular, Pill, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useState, useSyncExternalStore } from 'react'
import { writeCommandAction } from '../api.js'
import { CommandButton, CommandModal, commandUnavailable, fieldLayout, useCommandInfo } from './command-action.jsx'

function pendingWrite(change) {
  return Boolean(change && !change.error && !change.waiting)
}

/** 同一会话的输入栏和面板共享设置请求，只有 Codex 的确认才会更新模式。 */
export function createPlanAction(session) {
  const store = createSnapshotStore(null)
  return { ...store, async select(mode, archived) {
    const { planRevision: revision } = session.getSnapshot()
    if (pendingWrite(store.getSnapshot())) return
    store.set({ revision })
    try {
      const result = await writeCommandAction({
        threadId: session.sessionId, action: 'plan', mode, ...(archived && { unarchive: true }),
      })
      if (result.confirmed) {
        session.publishPlanMode(result.mode, revision)
        store.set(null)
      } else {
        // 请求已接纳。等设置通知或历史检查点确认实际模式。
        store.set({ revision, waiting: true })
      }
    } catch (failure) {
      store.set({ error: failure.message })
    }
  } }
}

function usePlanChange(planAction, useSession) {
  const change = useSyncExternalStore(planAction.subscribe, planAction.getSnapshot)
  const revision = useSession(state => state.planRevision)
  return { pending: pendingWrite(change), waiting: Boolean(change?.waiting && change.revision === revision), error: change?.error }
}

/** 从 Codex 的目录取选项，当前值跟随该会话已经确认的设置。 */
export function PlanCommand({ command, onClose, sessionId, initialMode, planAction, useSession, t }) {
  const { info, error: readError } = useCommandInfo(sessionId, command)
  const unavailable = useSession(commandUnavailable)
  const archived = useSession(state => state.archived)
  const liveMode = useSession(state => state.planMode)
  const { pending, waiting, error } = usePlanChange(planAction, useSession)
  const [selection, setSelection] = useState(initialMode)
  const group = useId()
  const current = liveMode ?? info?.mode
  const selected = selection ?? current
  const modes = info?.modes ?? []
  const disabled = Boolean(unavailable || pending)
  return <CommandModal {...{ command, onClose, t, pending, waiting }}
    unavailable={unavailable ?? (!info && !readError ? 'loading' : info && !modes.length ? 'modesUnavailable' : undefined)}
    error={error || readError} footer={modes.length > 0 &&
      <CommandButton action="plan.apply" variant="primary" {...{ archived, t }}
        disabled={disabled || !modes.includes(selected) || (!waiting && selected === current)}
        onClick={() => planAction.select(selected, archived)} />}>
    <p>{t('plan.current')} <Pill>{t(current ? `plan.${current}` : 'plan.unknown')}</Pill></p>
    {modes.length > 0 && <div role="radiogroup" aria-label={t('plan.select')} style={fieldLayout}>
      {modes.map(mode => <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="radio" name={group} checked={selected === mode} disabled={disabled} onChange={() => setSelection(mode)} />
        {t(`plan.${mode}`)}
      </label>)}
    </div>}
  </CommandModal>
}

/** 在原生输入栏的计划席位显示已生效的模式与退出操作。 */
export function PlanChip({ controls, locked, useSession, t }) {
  if (!controls) return null
  return <PlanExit {...{ controls, locked, useSession, t }} />
}

function PlanExit({ controls, locked, useSession, t }) {
  const { commandRequest, planAction } = controls
  const mode = useSession(state => state.planMode)
  const archived = useSession(state => state.archived)
  const unavailable = useSession(commandUnavailable)
  const { pending, waiting, error } = usePlanChange(planAction, useSession)
  if (mode !== 'plan') return null
  const label = t(archived ? 'plan.exit.unarchive' : 'plan.exit')
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <Tooltip label={label} side="top" portal>
      <Button size="sm" variant="outline" icon={<IconPlanOutlineRegular size={14} />} aria-label={label}
        disabled={Boolean(unavailable || pending || (locked && !archived))}
        onClick={() => archived ? commandRequest.set({ command: 'plan', initialMode: 'default' }) : planAction.select('default', false)}>
        {t(pending || waiting ? 'plan.exiting' : 'plan')} <IconCloseCircleFillRegular size={12} aria-hidden="true" />
      </Button>
    </Tooltip>
    {error && <Tooltip label={error} side="top" portal>
      <span role="alert" title={error} style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{t('plan.changeFailed')}</span>
    </Tooltip>}
  </span>
}
