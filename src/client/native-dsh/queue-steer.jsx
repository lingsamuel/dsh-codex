import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, useState } from 'react'

const empty = []
const states = ['steering', 'unconfirmed', 'recoverable']

function download(item) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'codex-queued-message.json'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** 用原生 QueueDock 的等待行显示正文和附件，待确认的条目不进入可操作的待发列表。 */
export function QueueSteerDock({ Dock, dockProps, t }) {
  const { useProjection, useSession, updateQueue, notify } = dockProps
  const records = useProjection('inbox', inbox => inbox?.queuedSteers) ?? empty
  const canRestore = useSession(state => !state.archived && state.canAcceptDirectInput !== false)
  const groups = useMemo(() => Map.groupBy(records, record => record.status), [records])
  const [busy, setBusy] = useState(false)

  async function apply(kind, id) {
    setBusy(true)
    try {
      await updateQueue(id, { kind })
    } catch {
      notify('error', t(kind === 'check-steer' ? 'checkFailed' : 'restoreFailed'))
    } finally {
      setBusy(false)
    }
  }

  return states.map(status => {
    const rows = groups.get(status)
    if (!rows) return null
    return <div key={status}>
      <Dock {...dockProps} useProjection={() => undefined}
        useSession={select => useSession(state => select({ ...state, pendingSubmissions: rows }))}
        t={(key, ...args) => key === 'queue.sending' ? t(status) : dockProps.t(key, ...args)} />
      {status === 'unconfirmed' && <Button size="sm" variant="ghost" disabled={busy}
        onClick={() => apply('check-steer', rows[0].item.id)}>{t('check')}</Button>}
      {status !== 'steering' && rows.map(({ item, text }, index) => {
        const suffix = rows.length > 1 ? ` · ${text.trim().slice(0, 36) || index + 1}` : ''
        return <span key={item.id}>
          {status === 'recoverable' && canRestore && <Button size="sm" variant="ghost" disabled={busy}
            onClick={() => apply('restore-steer', item.id)}>{t('restore')}{suffix}</Button>}
          <Button size="sm" variant="ghost" onClick={() => download(item)}>{t('download')}{suffix}</Button>
        </span>
      })}
    </div>
  })
}
