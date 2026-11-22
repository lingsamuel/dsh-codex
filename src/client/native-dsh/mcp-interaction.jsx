import { Button, Checkbox, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useRef, useState } from 'react'
import { writeMcpElicitation } from '../api.js'
import { mcpFieldInput } from './mcp-field-input.js'

const locale = 'codex.mcpInteraction'
const labels = {
  zh: {
    title: 'MCP 请求', from: '来自 {server}', close: '关闭 MCP 请求', choose: '选择 MCP 请求',
    accept: '提交表单', continue: '已完成，继续', decline: '拒绝', cancel: '取消', open: '打开授权页面',
    urlHint: '在授权页面完成操作后，返回此处继续。', unset: '未填写', yes: '是', no: '否', required: '必填',
    dateTime: '例如 2026-11-23T12:00:00+08:00',
  },
  en: {
    title: 'MCP requests', from: 'From {server}', close: 'Close MCP requests', choose: 'Select MCP request',
    accept: 'Submit form', continue: 'Done, continue', decline: 'Decline', cancel: 'Cancel', open: 'Open authorization page',
    urlHint: 'Complete the action on the authorization page, then return here to continue.', unset: 'Unset', yes: 'Yes', no: 'No',
    required: 'Required', dateTime: 'For example, 2026-11-23T12:00:00+08:00',
  },
}
const card = { width: '100%', maxWidth: 'var(--dsh-chat-content-width, 48rem)', marginInline: 'auto', padding: '12px 16px',
  boxSizing: 'border-box', display: 'grid', gap: 8, maxHeight: 'var(--dsh-composer-text-max-height, 45vh)', overflowY: 'auto' }
const actions = { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }

function RequestField({ field, value, update, disabled, t }) {
  const id = useId()
  const title = field.title || field.name
  const label = field.required ? `${title} (${t('required')})` : title
  if (field.type === 'array') {
    const selected = value ?? []
    return <fieldset disabled={disabled} style={{ margin: 0, display: 'grid', gap: 4 }}>
      <legend>{label}</legend>
      {field.description && <span>{field.description}</span>}
      {field.options.map(({ value: choice, label: optionLabel }, index) => <Checkbox key={index} label={optionLabel}
        checked={selected.includes(choice)} disabled={disabled}
        onChange={checked => update(checked ? [...selected, choice] : selected.filter(entry => entry !== choice))} />)}
    </fieldset>
  }

  const options = field.options ?? (field.type === 'boolean' ? [{ value: true, label: t('yes') }, { value: false, label: t('no') }] : null)
  const numeric = field.type === 'integer' || field.type === 'number'
  const inputType = numeric ? 'number' : field.format === 'date' ? 'date' : field.format === 'email' ? 'email' : 'text'
  return <div style={{ display: 'grid', gap: 4 }}>
    <label htmlFor={id}>{label}</label>
    {field.description && <span id={`${id}-description`}>{field.description}</span>}
    {options ? <select id={id} disabled={disabled} required={field.required} value={options.findIndex(option => option.value === value)}
      aria-describedby={field.description ? `${id}-description` : undefined}
      onChange={event => update(options[Number(event.target.value)]?.value)}>
      <option value="-1">{t('unset')}</option>
      {options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}
    </select> : <Input id={id} type={inputType} value={value ?? ''} disabled={disabled} autoComplete="off" spellCheck={false}
      min={field.minimum ?? undefined} max={field.maximum ?? undefined} step={field.type === 'integer' ? 1 : 'any'}
      aria-required={field.required} aria-describedby={field.description ? `${id}-description` : undefined}
      placeholder={field.format === 'date-time' ? t('dateTime') : undefined}
      onChange={event => update(mcpFieldInput(field, event.target))} />}
  </div>
}

function McpRequestCard({ request, t }) {
  // 表单值随卡片和原生请求一起销毁，不接入 DSH 的草稿存储。
  const [values, setValues] = useState(() => Object.fromEntries((request.fields ?? []).flatMap(field => {
    if (Object.hasOwn(field, 'default')) return [[field.name, field.default]]
    if (field.required && field.type === 'string' && !field.options && !field.format) return [[field.name, '']]
    return []
  })))
  const [opened, setOpened] = useState(false)
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { key, threadId, requestId } = request

  async function respond(action) {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      await writeMcpElicitation({ key, threadId, requestId, action, ...(action === 'accept' && request.mode === 'form' && { content: values }) })
      setValues({})
    } catch (failure) {
      sending.current = false
      setBusy(false)
      setError(failure.message)
    }
  }

  return <section data-codex-mcp-request={key} style={card} aria-label={t('from', { server: request.serverName })}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <StateDot state={busy ? 'ongoing' : 'warning'} />
      <strong>{t('from', { server: request.serverName })}</strong>
    </header>
    {request.message && <div style={{ whiteSpace: 'pre-wrap' }}>{request.message}</div>}
    {request.error && <div role="alert">{request.error}</div>}
    {request.mode === 'url' && <div>
      <p>{t('urlHint')}</p>
      <a href={request.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>{t('open')}</a>
      <div style={{ overflowWrap: 'anywhere' }}>{new URL(request.url).origin}</div>
    </div>}
    {request.fields?.map(field => <RequestField key={field.name} {...{ field, t }} disabled={busy}
      value={Object.hasOwn(values, field.name) ? values[field.name] : undefined} update={value => setValues(previous => {
        const next = { ...previous, [field.name]: value }
        if (value === undefined) delete next[field.name]
        return next
      })} />)}
    {error && <p role="alert">{error}</p>}
    <div style={actions}>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void respond('cancel')}>{t('cancel')}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void respond('decline')}>{t('decline')}</Button>
      {!request.error && <Button variant="primary" size="sm" disabled={busy || (request.mode === 'url' && !opened)}
        onClick={() => void respond('accept')}>{t(request.mode === 'url' ? 'continue' : 'accept')}</Button>}
    </div>
  </section>
}

function McpComposer({ matched, useProjection, t }) {
  const request = useProjection('codexMcpRequests', requests => requests?.find(entry => entry.key === matched.key))
  return request && <McpRequestCard key={request.key} {...{ request, t }} />
}

function McpUtilities({ useProjection, t }) {
  const requests = useProjection('codexMcpRequests') ?? []
  const [openKey, setOpenKey] = useState(null)
  const open = requests.find(request => request.key === openKey)
  if (!requests.length) return null
  return <>
    <Button size="sm" variant="toolbar" onClick={() => setOpenKey(requests[0].key)}>{t('title')}</Button>
    {open && <Modal open title={t('title')} closeLabel={t('close')} onClose={() => setOpenKey(null)}>
      {requests.length > 1 && <select aria-label={t('choose')} value={open.key} onChange={event => setOpenKey(event.target.value)}>
        {requests.map(request => <option key={request.key} value={request.key}>{t('from', { server: request.serverName })}</option>)}
      </select>}
      <McpRequestCard key={open.key} request={open} t={t} />
    </Modal>}
  </>
}

/** 复用会话待处理交互投影，在输入栏与标题栏呈现原生 MCP 请求。 */
export function installCodexMcpInteractions(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const name = 'conversation.composer'
  const utilities = 'conversation.session.header.utilities'
  ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'codex-mcp-interaction', locale,
    select: ({ pendingInteraction }) => pendingInteraction?.codexMcp ? pendingInteraction : null,
  }, McpComposer))
  ctx.slots.inject(utilities, () => ctx.slots.register({ name: utilities, id: 'codex-open-mcp', order: 56, locale }, McpUtilities))
}
