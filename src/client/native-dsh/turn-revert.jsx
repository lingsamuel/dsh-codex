import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconClockOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { writeThreadAction } from '../api.js'

const locale = 'codex.turn.revert'
const actions = 'conversation.chat.assistant-actions'
const overlay = 'shell.overlay'
const labels = {
  zh: {
    revert: '回退到此轮之前', unavailable: '请在 Codex CLI 中打开此会话并等待当前操作结束。',
    description: '将从当前会话移除这一轮和之后的对话记录。此操作无法撤销，工作区文件和已执行的工具操作会保留。',
    confirm: '确认回退', cancel: '取消', close: '关闭', pending: '正在回退会话…',
  },
  en: {
    revert: 'Revert to before this turn', unavailable: 'Open this session in Codex CLI and wait for any current operation to finish.',
    description: 'This turn and all later turns will be permanently removed from this conversation. Workspace files and completed tool actions will be kept.',
    confirm: 'Revert history', cancel: 'Cancel', close: 'Close', pending: 'Reverting conversation…',
  },
}

function matchNativeActionStyle(button) {
  const copy = button?.closest('[data-clock="end"]')?.querySelector('button')
  if (copy && copy !== button) button.className = copy.className
}

function TurnRevert({ messageId, useSession, requestRevert, t }) {
  const paginated = useSession(state => state.historyMode === 'paginated' && !state.archived && !state.subagent)
  const idle = useSession(state => state.live.status?.type === 'idle' && state.canAcceptDirectInput !== false)
  if (!paginated) return null
  return <Tooltip label={t(idle ? 'revert' : 'unavailable')} side="bottom" openOnClick={!idle}>
    <button type="button" ref={matchNativeActionStyle} aria-label={t('revert')} aria-disabled={!idle || undefined}
      data-unavailable={!idle || undefined} onClick={idle ? () => requestRevert(messageId) : undefined}>
      <IconClockOutlineRegular />
    </button>
  </Tooltip>
}

function RevertDialog({ request, close, t }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setPending(true)
    setError('')
    try {
      await writeThreadAction({ ...request, action: 'revert' })
      close()
    } catch (failure) {
      setError(failure.message)
      setPending(false)
    }
  }

  function cancel() {
    if (!pending) close()
  }

  return <Modal open title={t('revert')} tone="warning" description={t('description')} closeLabel={t('close')}
    onClose={cancel} footer={<>
      <Button variant="outline" data-modal-autofocus disabled={pending} onClick={cancel}>{t('cancel')}</Button>
      <Button variant="outline" disabled={pending} onClick={confirm}>{t('confirm')}</Button>
    </>}>
    {pending && <p role="status">{t('pending')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

function RevertOverlay({ useRevertRequest, close, t }) {
  const request = useRevertRequest(value => value)
  return request && <RevertDialog key={request.beforeTurnId} request={request} close={close} t={t} />
}

/** 回退沿用 DSH 回复操作栏的显隐规则，页面层的确认框独立于历史刷新。 */
export function installTurnRevert(ctx) {
  const request = createSnapshotStore(null)
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['sessions'], scope => {
    scope.slots.inject(actions, () => scope.slots.register({
      name: actions, id: 'codex-turn-revert', locale,
      inject: threadId => ({
        requestRevert(messageId) {
          const beforeTurnId = scope.sessions.binding(threadId)?.session.finishedTurnOfReply(messageId)
          if (beforeTurnId) request.set({ threadId, beforeTurnId })
        },
      }),
    }, TurnRevert))
  })
  ctx.slots.inject(overlay, () => ctx.slots.register({
    name: overlay, id: 'codex-turn-revert-confirm', locale,
    inject: () => ({ hooks: { revertRequest: request }, close: () => request.set(null) }),
  }, RevertOverlay))
}
