import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconEditOutlineRegular, InlineEditor, Modal, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { writeThreadAction } from '../api.js'

const locale = 'codex.message.edit'
const chatNode = 'conversation.chat.node'
const historyContent = 'conversation.chat.user.content'
const overlay = 'shell.overlay'
const editLayout = { display: 'grid', gap: '8px', width: 'min(100%, 38rem)' }
const editFooter = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }
const editControls = { display: 'flex', alignItems: 'center', gap: '6px', marginInlineStart: 'auto' }
const editWarning = { color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)' }
const labels = {
  zh: { edit: '编辑消息', cancel: '取消', send: '发送', sending: '正在发送…',
    warning: '发送会替换这一轮及之后的对话记录。',
    failed: '无法提交编辑', copy: '复制修改后的消息', copied: '已复制', close: '关闭' },
  en: { edit: 'Edit message', cancel: 'Cancel', send: 'Send', sending: 'Sending…',
    warning: 'Sending replaces this turn and all later conversation history.',
    failed: 'Could not submit edit', copy: 'Copy revised message', copied: 'Copied', close: 'Close' },
}

function EditableUserMessage({ Native, session, threadId, reportFailure, tEdit, ...props }) {
  const { node, renderFactorySlot } = props
  const { archived, canAcceptDirectInput, historyMode, live, subagent } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const source = !archived && !subagent && historyMode === 'paginated'
    ? session.editableInput(node.location.turn?.turn, node.data.seq) : undefined
  const editable = ['idle', 'notLoaded'].includes(live.status?.type) && canAcceptDirectInput !== false
  const anchor = useRef(null)
  const headAtEdit = useRef(null)
  const [chrome, setChrome] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const editing = draft !== null
  const t = tEdit

  useLayoutEffect(() => {
    // RC2 的用户消息没有动作 Slot。编辑入口加入原生复制按钮所在的行。
    const row = anchor.current?.closest('[data-chat-flow-kind="user"]')
    setChrome(row?.querySelector('[data-clock="start"]') ?? null)
  }, [Boolean(source)])

  useLayoutEffect(() => {
    if (!chrome || !editing) return
    // 编辑区已提供自己的操作栏。保留原生复制行并在退出编辑时恢复。
    const display = chrome.style.display
    chrome.style.display = 'none'
    return () => { chrome.style.display = display }
  }, [chrome, editing])

  function cancel() {
    if (!saving) setDraft(null)
  }

  const canSend = source && editable && !saving && (draft?.trim() || source.hasAttachments)
  async function send() {
    if (!canSend) return
    const { beforeTurnId, itemId } = source
    const modelDraft = session.modelDraft.getSnapshot()
    setSaving(true)
    try {
      await writeThreadAction({ threadId, action: 'edit', beforeTurnId, itemId, text: draft, headTurnId: headAtEdit.current, modelDraft })
      session.modelDraft.clear(modelDraft)
      setDraft(null)
    } catch (failure) {
      // 回退后原消息可能已移出视图。把草稿交给页面弹窗，供复制或核对发送结果。
      reportFailure({ text: draft, message: failure.message })
    } finally {
      setSaving(false)
    }
  }

  function renderContent(name, input, ...args) {
    if (name !== historyContent || !editing || !source) return renderFactorySlot(name, input, ...args)
    const originalWithAttachments = { ...input, content: { ...input.content, text: '', extraBlocks: [] } }
    return <>
      {renderFactorySlot(name, originalWithAttachments, ...args)}
      <div style={editLayout}>
        <InlineEditor label={t('edit')} value={draft} onChange={value => { if (!saving) setDraft(value) }}
          onSave={send} onCancel={cancel} />
        <div style={editFooter}>
          <small style={editWarning}>{t('warning')}</small>
          <div style={editControls}>
            <Button size="sm" variant="ghost" disabled={saving} onClick={cancel}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={!canSend} onClick={send}>{t(saving ? 'sending' : 'send')}</Button>
          </div>
        </div>
      </div>
    </>
  }

  return <>
    {source && <span ref={anchor} hidden />}
    <Native {...props} renderFactorySlot={renderContent} />
    {chrome && source && !editing && createPortal(
      <Tooltip label={t('edit')} side="bottom">
        <button type="button" className={chrome.querySelector('button')?.className} aria-label={t('edit')} disabled={!editable}
          onClick={() => { headAtEdit.current = source.headTurnId; setDraft(source.text) }}><IconEditOutlineRegular /></button>
      </Tooltip>, chrome)}
  </>
}

function EditFailure({ useEditFailure, close, t }) {
  const draft = useEditFailure(value => value)
  const [copied, setCopied] = useState(null)
  async function copy() {
    if (await writeClipboard(draft.text)) setCopied(draft)
  }
  return draft && <Modal open title={t('failed')} tone="warning" closeLabel={t('close')} onClose={close}
    description={draft.message} footer={<>
      <Button variant="outline" onClick={close}>{t('close')}</Button>
      <Button onClick={copy}>{t(copied === draft ? 'copied' : 'copy')}</Button>
    </>} />
}

/** 在用户消息渲染入口增加就地编辑，正常阅读继续走 DSH 的气泡和内容 Factory。 */
export function installMessageEdit(ctx) {
  const failure = createSnapshotStore(null)
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.inject(['sessions'], scope => {
    scope.effect(() => {
      let native
      let restore
      function sync() {
        const entry = scope.slots.entries(chatNode).find(entry => entry.options.key === 'user')
        if (entry === native) return
        restore?.()
        native = entry
        restore = undefined
        if (!entry?.component) return
        const Component = entry.component
        const inject = entry.inject
        const editBinding = (id, ...args) => ({
          ...inject?.(id, ...args), editSession: scope.sessions.binding(id)?.session, editThreadId: id,
        })
        function UserMessage({ editSession: session, editThreadId: threadId, ...props }) {
          if (!session) return <Component {...props} />
          return <EditableUserMessage {...props} Native={Component} session={session} threadId={threadId} tEdit={t}
            reportFailure={draft => failure.set(draft)} />
        }
        entry.component = UserMessage
        entry.inject = editBinding
        restore = () => {
          if (entry.component === UserMessage) entry.component = Component
          if (entry.inject === editBinding) entry.inject = inject
        }
      }
      const unsubscribe = scope.on('slots/changed', name => { if (name === chatNode) sync() })
      sync()
      return () => { unsubscribe(); restore?.() }
    })
  })
  ctx.slots.inject(overlay, () => ctx.slots.register({
    name: overlay, id: 'codex-edit-failure', locale,
    inject: () => ({ hooks: { editFailure: failure }, close: () => failure.set(null) }),
  }, EditFailure))
}
