import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState } from 'react'
import { writeApprovalDecision } from '../api.js'

const composer = 'conversation.composer'
const utilities = 'conversation.session.header.utilities'
const locale = 'codex.approval'
const labels = {
  zh: {
    open: '查看待审批请求', close: '关闭审批', select: '选择审批请求',
    command: '允许执行命令？', 'terminal-input': '允许向终端写入输入？', network: '允许访问网络？',
    'file-change': '允许修改文件？', permissions: '授予请求的额外权限？',
    workspace: '工作目录 {path}', root: '请求写入范围 {path}',
    filesystem: '文件系统权限', networkAccess: '网络访问权限',
    read: '读取 {path}', write: '写入 {path}', deny: '拒绝访问 {path}', snapshotPending: '等待 Codex 提供文件变更详情。此时可以取消操作。',
    'change.add': '新增 {path}', 'change.delete': '删除 {path}', 'change.update': '修改 {path}', 'change.move': '移动 {path} → {destination}',
    accept: '本次允许', 'accept.turn': '本轮允许', acceptForSession: '本会话允许', decline: '拒绝', cancel: '取消操作',
  },
  en: {
    open: 'View pending approvals', close: 'Close approvals', select: 'Select approval request',
    command: 'Allow this command?', 'terminal-input': 'Allow sending input to the terminal?', network: 'Allow network access?',
    'file-change': 'Allow these file changes?', permissions: 'Grant the requested additional permissions?',
    workspace: 'Working directory {path}', root: 'Requested write scope {path}',
    filesystem: 'File system permissions', networkAccess: 'Network access',
    read: 'Read {path}', write: 'Write {path}', deny: 'Deny access to {path}', snapshotPending: 'Waiting for Codex to provide file change details. You can cancel the operation now.',
    'change.add': 'Add {path}', 'change.delete': 'Delete {path}', 'change.update': 'Edit {path}', 'change.move': 'Move {path} → {destination}',
    accept: 'Allow once', 'accept.turn': 'Allow for this turn', acceptForSession: 'Allow for this session', decline: 'Deny', cancel: 'Cancel operation',
  },
}

function useApprovalRequest(useProjection, key) {
  return useProjection('codexApprovals', approvals => approvals?.find(request => request.key === key))
}

function scopePath(path) {
  if (path.type === 'path') return path.path
  if (path.type === 'glob_pattern') return path.pattern
  const { kind, subpath, path: value } = path.value
  const root = value ?? (kind === 'project_roots' ? ':workspace_roots' : kind === 'slash_tmp' ? '/tmp' : `:${kind}`)
  return subpath ? `${root}/${subpath}` : root
}

function ApprovalRequestDetail({ request, t }) {
  const permissions = request.permissions ?? request.additionalPermissions
  const fileSystem = permissions?.fileSystem
  const paths = fileSystem?.entries?.length
    ? fileSystem.entries.map(({ path, access }) => t(access, { path: scopePath(path) }))
    : [...(fileSystem?.read ?? []).map(path => t('read', { path })), ...(fileSystem?.write ?? []).map(path => t('write', { path }))]
  const target = request.networkApprovalContext
  const entries = [
    target && `${target.protocol}://${target.host}`,
    request.command,
    request.cwd && t('workspace', { path: request.cwd }),
    request.grantRoot && t('root', { path: request.grantRoot }),
    permissions?.network?.enabled && t('networkAccess'),
  ].filter(Boolean)
  return <>
    {entries.map((entry, index) => <div key={index} style={{ whiteSpace: 'pre-wrap' }}>{entry}</div>)}
    {paths.length > 0 && <details open><summary>{t('filesystem')}</summary>
      {paths.map((path, index) => <div key={index}>{path}</div>)}
    </details>}
    {request.kind === 'file-change' && (request.changes?.length ? request.changes.map(({ path, kind, diff }, index) => {
      const destination = kind.type === 'update' && kind.move_path
      const title = t(destination ? 'change.move' : `change.${kind.type}`, { path, destination })
      return <details key={index}><summary>{title}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{diff}</pre></details>
    }) : <div>{t('snapshotPending')}</div>)}
  </>
}

function ApprovalCard({ request, renderFactorySlot, t }) {
  const responding = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const { key, threadId, requestId, decisions, reason, kind } = request
  const allow = decisions.find(decision => decision === 'accept') ?? decisions.find(decision => decision === 'acceptForSession')
  const deny = decisions.find(decision => decision === 'decline')
  const label = decision => t(decision === 'accept' && kind === 'permissions' ? 'accept.turn' : decision)

  async function decide(decision) {
    if (responding.current) return
    responding.current = true
    setPending(true)
    setError('')
    try {
      await writeApprovalDecision({ threadId, requestId, key, decision })
    } catch (failure) {
      responding.current = false
      setPending(false)
      setError(failure.message)
      throw failure
    }
  }

  const buttons = choices => choices.map(decision => <Button key={decision} size="sm" variant="outline"
    disabled={pending} onClick={() => { void decide(decision).catch(() => {}) }}>{label(decision)}</Button>)
  // DSH 卡片的拒绝按钮固定。仅有取消的请求必须显示为取消，避免混淆 Codex 的两种决定。
  const canRenderNativeCard = Boolean(allow && deny)
  const fallback = <>
    <strong>{t(kind)}</strong>
    {reason && <p>{reason}</p>}
    {buttons(canRenderNativeCard ? [deny, allow] : decisions)}
  </>
  return <section data-codex-approval={key}>
    <ApprovalRequestDetail request={request} t={t} />
    {canRenderNativeCard ? renderFactorySlot('conversation.approval.card', {
      requestKey: key, title: t(kind), description: reason ?? undefined, allowLabel: label(allow),
      canAnswer: () => !responding.current, onAllow: () => decide(allow), onReject: () => decide(deny),
    }, { fallback }) : fallback}
    {canRenderNativeCard && buttons(decisions.filter(decision => decision !== allow && decision !== deny))}
    {error && <p role="alert">{error}</p>}
  </section>
}

function ApprovalComposer({ matched, useProjection, renderFactorySlot, t }) {
  const request = useApprovalRequest(useProjection, matched.key)
  return request && <ApprovalCard key={request.key} {...{ request, renderFactorySlot, t }} />
}

function ApprovalUtilities({ useProjection, renderFactorySlot, t }) {
  const requests = useProjection('codexApprovals') ?? []
  const [openKey, setOpenKey] = useState(null)
  const open = requests.find(request => request.key === openKey)
  if (!requests.length) return null
  return <>
    <Button size="sm" variant="toolbar" aria-label={t('open')} onClick={() => setOpenKey(requests[0].key)}>{t('open')}</Button>
    {open && <Modal open title={t('open')} closeLabel={t('close')} onClose={() => setOpenKey(null)}>
      {requests.length > 1 && <select aria-label={t('select')} value={open.key} onChange={event => setOpenKey(event.target.value)}>
        {requests.map((request, index) => <option key={request.key} value={request.key}>{index + 1}. {t(request.kind)}</option>)}
      </select>}
      <ApprovalCard key={open.key} request={open} {...{ renderFactorySlot, t }} />
    </Modal>}
  </>
}

/** 注册原生审批卡入口。真实请求与黄点分开，问答在输入栏优先，审批仍可从标题栏打开。 */
export function installCodexApprovals(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['uiSession'], scope => {
    const publish = scope.uiSession.registerPendingInteraction(() => 0.5)
    const installed = new WeakSet()
    scope.uiSession.provide({
      resolve(binding) {
        if (!installed.has(binding)) {
          installed.add(binding)
          binding.ctx.effect(() => {
            const approvals = binding.session.projections.faceOf('codexApprovals')
            let current
            let remove
            function sync() {
              const key = approvals.getSnapshot()?.[0]?.key
              if (key === current) return
              remove?.()
              remove = key && publish({ sessionId: binding.sessionId, kind: 'approval', key, codexApproval: true }, async () => {})
              current = key
            }
            const unsubscribe = approvals.subscribe(sync)
            sync()
            return () => { unsubscribe(); remove?.() }
          })
        }
        return {}
      },
    })
  })
  ctx.slots.inject(composer, () => ctx.slots.register({ name: composer, id: 'codex-approval', locale,
    select: ({ pendingInteraction }) => pendingInteraction?.codexApproval ? pendingInteraction : null,
  }, ApprovalComposer))
  ctx.slots.inject(utilities, () => ctx.slots.register({ name: utilities, id: 'codex-open-approval', order: 55, locale }, ApprovalUtilities))
}
