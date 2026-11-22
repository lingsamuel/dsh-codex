const standardDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel'])
const supportedMethods = new Map([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'file-change'],
  ['item/permissions/requestApproval', 'permissions'],
])

/** 保留 Codex 返回的可选操作。旧协议未提供列表时沿用 CLI 的默认范围。 */
export function projectApprovalRequest(method, params) {
  let kind = supportedMethods.get(method)
  if (!kind) return
  const { threadId, turnId, itemId, reason, command, cwd, networkApprovalContext,
    grantRoot, permissions, additionalPermissions, availableDecisions } = params
  if (kind === 'command' && networkApprovalContext) kind = 'network'
  else if (kind === 'command' && params.kind === 'writeStdin') kind = 'terminal-input'

  let decisions
  if (kind === 'permissions') {
    if (!permissions?.fileSystem && !permissions?.network) return
    decisions = ['accept', 'acceptForSession', 'decline']
  } else if (kind === 'file-change') {
    decisions = ['cancel']
  } else {
    const defaults = kind === 'network' ? ['accept', 'acceptForSession', 'cancel'] : ['accept', 'cancel']
    decisions = Array.isArray(availableDecisions) ? availableDecisions.filter(value => standardDecisions.has(value)) : defaults
  }
  if (!decisions.length) return
  return { threadId, turnId, itemId, kind, reason, command, cwd, networkApprovalContext, grantRoot,
    permissions, additionalPermissions, decisions }
}

/** 完整展示补丁范围后才能授予文件写入。没有原生详情时仍可取消。 */
export function hydrateFileApproval(approval, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.some(change => typeof change?.path !== 'string'
    || typeof change.diff !== 'string' || !['add', 'delete', 'update'].includes(change.kind?.type))) return
  return { ...approval, changes, decisions: ['accept', 'acceptForSession', 'cancel'] }
}

/** 应答只能选择已发布的决定。权限范围始终来自同一个原生请求。 */
export function approvalResponse(approval, decision) {
  if (!approval.decisions.includes(decision)) return
  if (approval.kind !== 'permissions') return { decision }
  const { network, fileSystem } = approval.permissions
  const permissions = decision === 'decline' ? {} : {
    ...(network && { network }), ...(fileSystem && { fileSystem }),
  }
  return { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
}
