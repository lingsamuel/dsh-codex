import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage, writeCommandAction } from '../api.js'

export const fieldLayout = { display: 'grid', gap: 6 }

export const textAreaStyle = {
  width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '8px 10px',
  font: 'inherit', color: 'inherit', background: 'var(--dsw-specific-input-major)',
  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-sm)',
}

/** 共用会话的写入权限。启动轮次的命令另需检查会话是否空闲。 */
export function commandUnavailable(state) {
  return state.removed || state.subagent || state.canAcceptDirectInput === false ? 'readOnly'
    : state.openState === 'loading' ? 'loading'
      : state.openState !== 'open' ? 'unavailable'
        : undefined
}

/** 只在打开需要详情的命令时查询。关闭后取消这次读取。 */
export function useCommandInfo(sessionId, view, refresh, captureRevision) {
  const [read, setRead] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    const { signal } = abort
    const revision = captureRevision?.()
    readPage('thread-info', { threadId: sessionId, view }, signal).then(data => {
      if (signal.aborted) return
      setRead({ info: data, revision })
      setError('')
    }).catch(failure => {
      if (!signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [sessionId, view, refresh, captureRevision])
  return { info: read?.info, revisionAtRead: read?.revision, error }
}

/** 写请求使用打开面板时的会话。切换会话后，原生操作仍可完成。 */
export function useCommandAction(session, archived) {
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function submit(parameters, accept) {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    const before = session.getSnapshot()
    try {
      const result = await (session.runCommand?.(parameters)
        ?? writeCommandAction({ threadId: session.sessionId, ...parameters, ...(archived && { unarchive: true }) }))
      accept?.(result, before)
    } catch (failure) {
      if (mounted.current) setError(failure.message)
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  return { pending, error, submit }
}

/** 提交期间保留当前表单，原生确认仍在等待时允许关闭面板。 */
export function CommandModal({ command, onClose, t, pending, waiting, error, unavailable, footer, children, ...props }) {
  return <Modal open title={t(command)} closeLabel={t('close')} onClose={pending ? () => {} : onClose} footer={footer} {...props}>
    {children}
    {unavailable && <p role="status">{t(unavailable)}</p>}
    {(pending || waiting) && <p role="status">{t(waiting ? 'awaitingMode' : 'pending')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

/** 需要恢复归档会话时，在动作按钮上明确展示两步操作。 */
export function CommandButton({ action, archived, t, ...props }) {
  return <Button {...props}>{t(archived ? `${action}.unarchive` : action)}</Button>
}
