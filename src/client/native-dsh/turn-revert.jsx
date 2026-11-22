import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconClockOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { writeThreadAction } from '../api.js'

const locale = 'codex.turn.revert'
const actions = 'conversation.chat.assistant-actions'
const overlay = 'shell.overlay'
const labels = {
  zh: {
    revert: '删除本轮及后续对话', unavailable: '当前会话暂不可修改历史。请在 Codex CLI 中检查会话状态。',
    unloaded: 'Codex 尚未加载此会话。请先在 CLI 中打开。',
    running: '会话仍在运行。请在 Codex CLI 中停止当前轮次，或等待它结束。',
    description: '将删除本轮的提问、回复和工具记录，以及之后的所有轮次。此操作无法撤销。工作区文件和已执行操作的影响会保留。',
    confirm: '确认删除', cancel: '取消', close: '关闭', pending: '正在删除对话记录…',
  },
  en: {
    revert: 'Delete this turn and later history', unavailable: 'This session’s history is unavailable for editing. Check its status in Codex CLI.',
    unloaded: 'Codex has not loaded this session. Open it in the CLI first.',
    running: 'This session is running. Stop the current turn in Codex CLI or wait for it to finish.',
    description: 'This turn’s prompt, reply, and tool records will be deleted along with all later turns. This cannot be undone. Workspace files and the effects of completed actions will be kept.',
    confirm: 'Delete conversation history', cancel: 'Cancel', close: 'Close', pending: 'Deleting conversation history…',
  },
}

function matchNativeActionStyle(button) {
  const copy = button?.closest('[data-clock="end"]')?.querySelector('button')
  if (copy && copy !== button) button.className = copy.className
}

function TurnRevert({ messageId, useSession, requestRevert, t }) {
  const paginated = useSession(state => state.historyMode === 'paginated' && !state.archived && !state.subagent)
  const unavailable = useSession(({ live, canAcceptDirectInput }) => {
    if (live.status?.type === 'notLoaded') return 'unloaded'
    if (live.status?.type === 'active') return 'running'
    return live.status?.type === 'idle' && canAcceptDirectInput !== false ? null : 'unavailable'
  })
  if (!paginated) return null
  return <Tooltip label={t(unavailable ?? 'revert')} side="bottom" openOnClick={Boolean(unavailable)}>
    <button type="button" ref={matchNativeActionStyle} aria-label={t('revert')} aria-disabled={Boolean(unavailable) || undefined}
      data-unavailable={Boolean(unavailable) || undefined} onClick={unavailable ? undefined : () => requestRevert(messageId)}>
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
