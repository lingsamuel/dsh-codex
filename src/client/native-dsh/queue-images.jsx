import { Button, InlineEditor, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { userInputText } from '../../shared/user-input.js'
import { FileDownloads } from './file-downloads.jsx'

const dock = 'conversation.input.dock'
const locale = 'codex.queue.images'
const copy = {
  zh: { edit: '编辑待发附件消息', message: '待发消息', image: '图片', text: '消息文字', download: '下载 {name}',
    cancel: '取消', save: '保存', failed: '无法保存待发消息' },
  en: { edit: 'Edit queued attachment message', message: 'Queued message', image: 'Image', text: 'Message text', download: 'Download {name}',
    cancel: 'Cancel', save: 'Save', failed: 'Could not save the queued message' },
}

function QueueImageEdit({ useSession, useProjection, updateQueue, notify, t }) {
  const editable = useSession(state => !state.subagent && !state.archived && state.canAcceptDirectInput !== false)
  const inbox = useProjection('inbox')
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const rows = inbox?.['next-turn']?.filter(row => row.content.some(part => part.type === 'image' || part.type === 'file')) ?? []
  if (!rows.length) return null
  const current = rows.find(row => row.id === draft?.id)

  function select(row) {
    setDraft({ id: row.id, text: userInputText(row.content) })
  }

  function close() {
    if (!saving) setDraft(null)
  }

  async function save() {
    if (!current || saving) return
    setSaving(true)
    try {
      await updateQueue(draft.id, { kind: 'edit', content: [{ type: 'text', text: draft.text }] })
      setDraft(null)
    } catch {
      notify('error', t('failed'))
    } finally {
      setSaving(false)
    }
  }

  return <>
    <FileDownloads files={rows.flatMap(row => row.content.filter(part => part.type === 'file').map(part => part.attachment))}
      label={name => t('download', { name })} />
    {editable && <Button size="sm" variant="ghost" onClick={() => select(rows[0])}>{t('edit')}</Button>}
    {editable && current && <Modal open title={t('edit')} closeLabel={t('cancel')} onClose={close}
      footer={<>
        <Button variant="ghost" disabled={saving} onClick={close}>{t('cancel')}</Button>
        <Button disabled={saving} onClick={save}>{t('save')}</Button>
      </>}>
      {rows.length > 1 && <select aria-label={t('message')} value={draft.id} disabled={saving}
        onChange={event => select(rows.find(row => row.id === event.target.value))}>
        {rows.map((row, index) => <option key={row.id} value={row.id}>
          {index + 1}. {userInputText(row.content).trim().slice(0, 60) || row.content.find(part => part.type === 'file')?.attachment.name || t('image')}
        </option>)}
      </select>}
      <InlineEditor label={t('text')} value={draft.text} onSave={save} onCancel={close}
        onChange={text => { if (!saving) setDraft({ id: draft.id, text }) }} />
    </Modal>}
  </>
}

/** 原生队列负责显示、移除和插话，附件行使用同一队列操作编辑正文。 */
export function installQueueImages(ctx) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  const t = ctx.locale.bind(locale)
  ctx.inject(['sessions'], scope => scope.effect(() => {
    let native
    let restore
    function sync() {
      const entry = scope.slots.entries(dock).find(entry => entry.options.id === 'queue')
      if (entry === native) return
      restore?.()
      native = entry
      restore = undefined
      const inject = entry?.inject
      const Component = entry?.component
      if (!inject || !Component) return
      const injectQueue = (sessionId, ...args) => {
        const props = inject(sessionId, ...args)
        return { ...props, async loadImage(attachment) {
          const session = scope.sessions.binding(sessionId)?.session
          return session?.queuedImageUrl(attachment.attachmentId) ?? props.loadImage(attachment)
        } }
      }
      function Queue(props) {
        return <><Component {...props} /><QueueImageEdit {...props} t={t} /></>
      }
      entry.inject = injectQueue
      entry.component = Queue
      restore = () => {
        if (entry.inject === injectQueue) entry.inject = inject
        if (entry.component === Queue) entry.component = Component
      }
    }
    const unsubscribe = scope.on('slots/changed', name => { if (name === dock) sync() })
    sync()
    return () => {
      unsubscribe()
      restore?.()
    }
  }))
}
