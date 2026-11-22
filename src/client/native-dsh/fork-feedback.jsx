import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

const locale = 'codex.fork'
const overlay = 'shell.overlay'
const labels = {
  zh: {
    title: '从归档会话创建分支', description: 'Codex 需要先取消原会话的归档，再创建并打开新分支。',
    confirm: '取消归档并分叉', cancel: '取消', close: '关闭', pending: '正在创建分支…', failed: '分叉失败：{reason}',
  },
  en: {
    title: 'Branch from an archived session', description: 'Codex will unarchive the original session, then create and open the new branch.',
    confirm: 'Unarchive and branch', cancel: 'Cancel', close: 'Close', pending: 'Creating branch…', failed: 'Could not branch: {reason}',
  },
}

function cancelled() {
  return new DOMException('Fork cancelled', 'AbortError')
}

function ArchivedForkDialog({ request, finish, t }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  function cancel() {
    if (!pending) finish(request, undefined, cancelled())
  }
  async function confirm() {
    setError('')
    setPending(true)
    try {
      finish(request, await request.perform())
    } catch (failure) {
      setError(failure.message)
      setPending(false)
    }
  }
  return <Modal open tone="warning" title={t('title')} description={t('description')} closeLabel={t('close')} onClose={cancel}
    footer={<>
      <Button variant="outline" data-modal-autofocus disabled={pending} onClick={cancel}>{t('cancel')}</Button>
      <Button variant="primary" disabled={pending} onClick={confirm}>{t('confirm')}</Button>
    </>}>
    {pending && <p role="status">{t('pending')}</p>}
    {error && <p role="alert">{t('failed', { reason: error })}</p>}
  </Modal>
}

function ForkFeedback({ useArchiveFork, useForkError, finish, dismiss, t }) {
  const request = useArchiveFork(value => value)
  const error = useForkError(value => value)
  return <>
    {request && <ArchivedForkDialog key={request.id} request={request} finish={finish} t={t} />}
    {error && <Toast key={error.id} tone="error" text={t('failed', { reason: error.message })} onDone={() => dismiss(error)} />}
  </>
}

/** 汇合侧栏与轮次分叉。归档需要显式确认，普通分叉失败也会显示原因。 */
export function installForkFeedback(ctx) {
  const archiveFork = createSnapshotStore(null)
  const forkError = createSnapshotStore(null)
  let nextId = 0
  function finish(request, result, error) {
    if (archiveFork.getSnapshot() !== request) return
    archiveFork.set(null)
    if (error) request.reject(error)
    else request.resolve(result)
  }
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.effect(() => () => {
    const request = archiveFork.getSnapshot()
    if (request) finish(request, undefined, cancelled())
  })
  ctx.slots.inject(overlay, () => ctx.slots.register({
    name: overlay, id: 'codex-fork-feedback', locale,
    inject: () => ({ hooks: { archiveFork, forkError }, finish, dismiss: error => {
      if (forkError.getSnapshot() === error) forkError.set(null)
    } }),
  }, ForkFeedback))
  return async (archived, perform) => {
    if (!archived) {
      try {
        return await perform()
      } catch (error) {
        forkError.set({ id: ++nextId, message: error.message })
        throw error
      }
    }
    if (archiveFork.getSnapshot()) throw cancelled()
    const { promise, resolve, reject } = Promise.withResolvers()
    archiveFork.set({ id: ++nextId, perform, resolve, reject })
    return promise
  }
}
