const nativeOptions = new Map([
  [':read-only', 'read-only'],
  [':workspace', 'workspace-write'],
  [':danger-full-access', 'danger-full-access'],
])

/** 从 Codex RPC 或 rollout 设置构造有效权限，不把线程默认配置当作实际值。 */
export function permissionOf(settings, source = 'runtime') {
  if (!settings) return undefined
  const profile = settings.activePermissionProfile ?? settings.active_permission_profile
  const approval = settings.approvalPolicy ?? settings.approval_policy
  const reviewer = settings.approvalsReviewer ?? settings.approvals_reviewer
  const sandbox = settings.sandboxPolicy ?? settings.sandbox ?? settings.sandbox_policy ?? settings.permission_profile
  if (!profile?.id && !approval && !reviewer && !sandbox?.type) return undefined
  return {
    profileId: profile?.id ?? null,
    ...(approval != null && { approvalPolicy: typeof approval === 'string' ? approval : 'granular' }),
    ...(reviewer != null && { approvalsReviewer: reviewer }),
    ...(sandbox?.type && { sandbox: sandbox.type }),
    source,
  }
}

/** 内置预设使用 DSH 的既有标识，保留原生 ID 供提交和匹配。 */
export function permissionOptionValue(profileId) {
  return nativeOptions.get(profileId) ?? `codex:${profileId}`
}
