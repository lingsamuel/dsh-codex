import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useRef, useState, useSyncExternalStore } from 'react'
import { writeApprovalDecision } from '../api.js'

const composer = 'conversation.composer'
const utilities = 'conversation.session.header.utilities'
const detail = 'conversation.approval.detail'
const factoryName = 'conversation.approval.card'
const locale = 'codex.approval'
const labels = {
  zh: {
    open: '查看待审批请求', close: '关闭审批', select: '选择审批请求', waiting: '等待审批',
    command: '允许执行命令？', 'terminal-input': '允许向终端写入输入？', network: '允许访问网络？',
    'file-change': '允许修改文件？', permissions: '授予请求的额外权限？',
    workspace: '工作目录 {path}', root: '请求写入范围 {path}',
    filesystem: '文件系统权限', networkAccess: '网络访问权限',
    read: '读取 {path}', write: '写入 {path}', deny: '拒绝访问 {path}', snapshotPending: '等待 Codex 提供文件变更详情。此时可以取消操作。',
    'change.add': '新增 {path}', 'change.delete': '删除 {path}', 'change.update': '修改 {path}', 'change.move': '移动 {path} → {destination}',
    accept: '本次允许', 'accept.turn': '本轮允许', acceptForSession: '本会话允许', decline: '拒绝',
    'decline.continue': '不执行并继续', cancel: '取消本轮并补充指令',
  },
  en: {
    open: 'View pending approvals', close: 'Close approvals', select: 'Select approval request', waiting: 'Waiting for approval',
    command: 'Allow this command?', 'terminal-input': 'Allow sending input to the terminal?', network: 'Allow network access?',
    'file-change': 'Allow these file changes?', permissions: 'Grant the requested additional permissions?',
    workspace: 'Working directory {path}', root: 'Requested write scope {path}',
    filesystem: 'File system permissions', networkAccess: 'Network access',
    read: 'Read {path}', write: 'Write {path}', deny: 'Deny access to {path}', snapshotPending: 'Waiting for Codex to provide file change details. You can cancel the operation now.',
    'change.add': 'Add {path}', 'change.delete': 'Delete {path}', 'change.update': 'Edit {path}', 'change.move': 'Move {path} → {destination}',
    accept: 'Allow once', 'accept.turn': 'Allow for this turn', acceptForSession: 'Allow for this session', decline: 'Deny',
    'decline.continue': 'No, continue without running it', cancel: 'Cancel turn and give new instructions',
  },
}
const cardWidth = { width: '100%', maxWidth: 'var(--dsh-chat-content-width, 48rem)', marginInline: 'auto', boxSizing: 'border-box' }
const actionRow = { ...cardWidth, display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, padding: '8px 16px' }

function adaptNativeChoiceLabels(ctx) {
  const available = createSnapshotStore(false)
  ctx.effect(() => {
    // DSH 的审批卡固定使用 Reject 和 Always allow 文案。按本次 Codex 请求标注真实决定范围。
    const host = ctx.slots.hostFace?.()
    if (!host) return
    let current
    let restore
    function sync() {
      const entry = host.factoryOf(factoryName)
      if (entry === current) return
      restore?.()
      current = entry
      restore = undefined
      if (!entry?.component || !Object.getOwnPropertyDescriptor(entry, 'component')?.writable) {
        available.set(false)
        return
      }
      const Native = entry.component
      function ApprovalChoices({ codexChoiceLabels, t, ...props }) {
        return <Native {...props} t={(key, ...args) => codexChoiceLabels?.[key] ?? t(key, ...args)} />
      }
      entry.component = ApprovalChoices
      restore = () => { if (entry.component === ApprovalChoices) entry.component = Native }
      available.set(true)
    }
    const stop = host.subscribeFactory(factoryName, sync)
    sync()
    return () => { stop(); restore?.(); available.set(false) }
  })
  return available
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
    request.cwd && t('workspace', { path: request.cwd }),
    request.grantRoot && t('root', { path: request.grantRoot }),
    permissions?.network?.enabled && t('networkAccess'),
  ].filter(Boolean)
  return <div style={{ display: 'grid', gap: 6, overflowWrap: 'anywhere' }}>
    {request.command && <code style={{ whiteSpace: 'pre-wrap' }}>{request.command}</code>}
    {entries.map((entry, index) => <div key={index} style={{ whiteSpace: 'pre-wrap' }}>{entry}</div>)}
    {paths.length > 0 && <details open><summary>{t('filesystem')}</summary>
      {paths.map((path, index) => <div key={index}>{path}</div>)}
    </details>}
    {request.kind === 'file-change' && (request.changes?.length ? request.changes.map(({ path, kind, diff }, index) => {
      const destination = kind.type === 'update' && kind.move_path
      const title = t(destination ? 'change.move' : `change.${kind.type}`, { path, destination })
      return <details key={index}><summary>{title}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{diff}</pre></details>
    }) : <div>{t('snapshotPending')}</div>)}
  </div>
}

function NativeApprovalDetail({ callId, useProjection, t }) {
  const request = useApprovalRequest(useProjection, callId)
  return request && <ApprovalRequestDetail request={request} t={t} />
}

function ApprovalFallback({ request, pending, t, children }) {
  return <div data-codex-approval-fallback="" aria-busy={pending} style={{ ...cardWidth,
    overflow: 'hidden', border: '1px solid var(--dsw-alias-state-warn-secondary)', borderRadius: 'var(--dsw-radius-xl)',
    background: 'var(--dsw-specific-input-major)', boxShadow: 'var(--dsw-shadow-lv2)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', fontSize: 13,
      background: 'var(--dsw-alias-state-warn-tertiary)', color: 'var(--dsw-alias-state-warn-primary)',
    }}><StateDot state={pending ? 'ongoing' : 'warning'} />{t('waiting')}</div>
    <div style={{ display: 'grid', gap: 8, maxHeight: 'var(--dsh-composer-text-max-height, 45vh)', overflowY: 'auto', padding: '12px 16px 4px' }}>
      <strong>{t(request.kind)}</strong>
      {request.reason && <div>{request.reason}</div>}
      <ApprovalRequestDetail request={request} t={t} />
    </div>
    <div style={actionRow}>{children}</div>
  </div>
}

function ApprovalCard({ request, renderFactorySlot, nativeLabels, t }) {
  const responding = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const hasNativeLabels = useSyncExternalStore(nativeLabels.subscribe, nativeLabels.getSnapshot)
  const { key, threadId, requestId, decisions, reason, kind } = request
  const allow = decisions.find(decision => decision === 'accept') ?? decisions.find(decision => decision === 'acceptForSession')
  const deny = decisions.find(decision => decision === 'decline')
    ?? (hasNativeLabels ? decisions.find(decision => decision === 'cancel') : undefined)
  const sessionAllow = hasNativeLabels && allow === 'accept' && decisions.includes('acceptForSession') ? 'acceptForSession' : undefined
  function label(decision) {
    if (decision === 'accept' && kind === 'permissions') return t('accept.turn')
    if (decision === 'decline' && kind !== 'permissions') return t('decline.continue')
    return t(decision)
  }

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
  const canRenderNativeCard = Boolean(allow && deny)
  const fallback = <ApprovalFallback request={request} pending={pending} t={t}>
    {buttons(canRenderNativeCard ? [deny, allow, ...(sessionAllow ? [sessionAllow] : [])] : decisions)}
  </ApprovalFallback>
  const otherDecisions = canRenderNativeCard ? decisions.filter(decision => ![allow, deny, sessionAllow].includes(decision)) : []
  return <section data-codex-approval={key}>
    {canRenderNativeCard ? renderFactorySlot(factoryName, {
      requestKey: key, callId: key, title: t(kind), description: reason ?? undefined, allowLabel: label(allow),
      canAnswer: () => !responding.current, onAllow: () => decide(allow), onReject: () => decide(deny),
      ...(sessionAllow && { onAlways: () => decide(sessionAllow) }),
      ...(hasNativeLabels && { codexChoiceLabels: { reject: label(deny), allowAlways: label('acceptForSession') } }),
    }, { fallback }) : fallback}
    {otherDecisions.length > 0 && <div style={actionRow}>{buttons(otherDecisions)}</div>}
    {error && <p role="alert">{error}</p>}
  </section>
}

function ApprovalComposer({ matched, useProjection, renderFactorySlot, nativeLabels, t }) {
  const request = useApprovalRequest(useProjection, matched.key)
  return request && <ApprovalCard key={request.key} {...{ request, renderFactorySlot, nativeLabels, t }} />
}

function ApprovalUtilities({ useProjection, renderFactorySlot, nativeLabels, t }) {
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
      <ApprovalCard key={open.key} request={open} {...{ renderFactorySlot, nativeLabels, t }} />
    </Modal>}
  </>
}

/** 注册原生审批卡入口。真实请求与黄点分开，问答在输入栏优先，审批仍可从标题栏打开。 */
export function installCodexApprovals(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const nativeLabels = adaptNativeChoiceLabels(ctx)
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
    inject: () => ({ nativeLabels }),
  }, ApprovalComposer))
  ctx.slots.inject(utilities, () => ctx.slots.register({ name: utilities, id: 'codex-open-approval', order: 55, locale,
    inject: () => ({ nativeLabels }),
  }, ApprovalUtilities))
  // 原生聊天详情按 DSH 工具调用 ID 查找。Codex 请求在独立 Profile 使用自己的原生详情。
  ctx.slots.inject(detail, () => ctx.slots.register({ name: detail, id: 'codex-approval-detail', locale, priority: -1 }, NativeApprovalDetail))
}
