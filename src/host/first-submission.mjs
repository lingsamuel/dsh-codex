import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { threadTaskToolsConfig } from './codex-task-tools-config.mjs'
import { resolveWorktreeCwd, validateWorktreeSelection } from './git-worktrees.mjs'
import { validateModelDraft } from './models.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'

function invalid(message) {
  return new CodexRpcError({ code: -32602, message })
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function explicitlyRejected(error) {
  return error instanceof CodexRpcError && [-32600, -32601, -32602].includes(error.code)
}

/** 原生可能在确认入队与历史落盘之间暂时查不到回执。 */
export async function waitForFirstReceipt(signal, read) {
  const deadline = performance.now() + 750
  do {
    const result = await read()
    if (result) return result
    await delay(50, undefined, { signal })
  } while (performance.now() < deadline)
}

function receiptOf({ goal, turn, reviewThreadId, queuedSubmission, queuedForLater, permission, planMode }) {
  return {
    ...(goal && { goal }), ...(turn?.id && { turn: { id: turn.id } }), ...(reviewThreadId && { reviewThreadId }),
    ...(queuedSubmission?.id && { queuedSubmission: {
      id: queuedSubmission.id, clientUserMessageId: queuedSubmission.clientUserMessageId,
    } }),
    ...(queuedForLater && { queuedForLater }), ...(permission && { permission }), ...(planMode && { planMode }),
  }
}

async function workspaceOf(attempt) {
  const { thread } = attempt
  if (thread) return { thread, workspacePaths: await resolveWorkspacePaths([thread.cwd]) }
}

async function submissionConflict(attempt, changed = false) {
  return new CodexRpcError({ code: -32600,
    message: changed ? '首发内容已经变化，请先打开原生会话核对。' : '无法确认首次提交是否已送达，请打开目标会话核对或重试原请求。',
    data: { reason: changed ? 'new-session-input-changed' : 'new-session-delivery-unconfirmed',
      newSessionRecovery: await workspaceOf(attempt) },
  })
}

/** 网页临时 ID 只在显式提交时启动线程。只在内存留存原生目标、提交标识与简化回执。 */
export function createFirstSubmission(socketPath, submit, permissions, openProject) {
  const attempts = new Map()

  async function createThread(attempt, cwd, projectId, worktree, modelDraft, permissionDraft, signal) {
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw invalid('工作目录不可用，请重新选择。')
    const destination = worktree ? await resolveWorktreeCwd(cwd, worktree, signal) : cwd
    const create = async (rpc, retain) => {
      const project = projectId ?? (worktree && (await openProject(rpc, cwd)).project.id)
      if (permissionDraft !== undefined) {
        if (!permissions) throw invalid('Codex 权限选择不可用。')
        await permissions.validateSelection(rpc, destination, permissionDraft)
      }
      const options = permissionDraft === undefined
        ? await permissions?.startOptions(rpc, destination) : { permissions: permissionDraft }
      const config = await threadTaskToolsConfig(socketPath, signal)
      if (modelDraft?.reasoningEffort) config.model_reasoning_effort = modelDraft.reasoningEffort
      signal.throwIfAborted()
      attempt.state = 'opening'
      const started = await rpc('thread/start', {
        cwd: destination, historyMode: 'paginated', ...(project && { projectId: project }), ...options, config,
        ...(modelDraft && { modelProvider: modelDraft.provider, model: modelDraft.model }),
      }).catch(error => {
        if (explicitlyRejected(error)) attempt.state = 'ready'
        throw error
      })
      attempt.thread = started.thread
      attempt.permission = retain?.(started)
      attempt.state = 'ready'
    }
    if (permissions) await permissions.withThreadCreation(signal, create)
    else await withCodexReader(socketPath, signal, create)
  }

  return (fields, input, signal, execute, recover) => {
    const { action, threadId, clientUserMessageId, modelDraft, permissionDraft, planMode } = fields
    const { cwd, projectId } = fields.newSession ?? {}
    if (typeof clientUserMessageId !== 'string' || !clientUserMessageId.trim()) throw invalid('缺少提交 ID。')
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalid('请选择绝对路径的工作目录。')
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) throw invalid('项目 ID 无效。')
    if (permissionDraft !== undefined && (typeof permissionDraft !== 'string' || !permissionDraft.trim())) {
      throw invalid('缺少 Codex 权限预设。')
    }
    if (fields.unarchive === true || (planMode !== undefined && planMode !== 'plan')) throw invalid('无效的新会话设置。')
    validateModelDraft(undefined, modelDraft)
    const worktree = fields.worktree === undefined ? undefined : validateWorktreeSelection(fields.worktree)
    const target = digest([cwd, projectId, worktree, modelDraft?.provider, permissionDraft])
    const fingerprint = digest([action, input, planMode, modelDraft?.model, modelDraft?.reasoningEffort, target])
    const key = JSON.stringify([threadId, clientUserMessageId])
    return submit(threadId, async () => {
      signal.throwIfAborted()
      let attempt = attempts.get(key)
      if (attempt && attempt.state !== 'ready') {
        if (attempt.fingerprint !== fingerprint) throw await submissionConflict(attempt, true)
        if (attempt.state === 'accepted') return { ...attempt.receipt, ...await workspaceOf(attempt), clientUserMessageId }
        if (!attempt.thread || !recover) throw await submissionConflict(attempt)
      } else if (attempt?.target !== target) {
        attempt = { target, state: 'ready' }
      }
      attempts.delete(key)
      attempts.set(key, attempt)
      attempt.inProgress = true
      const finish = async result => {
        attempt.receipt = receiptOf({ ...result, planMode: result.planMode ?? (action === 'prompt' ? planMode : undefined),
          permission: result.permission ?? attempt.permission })
        attempt.state = 'accepted'
        return { ...attempt.receipt, ...await workspaceOf(attempt), clientUserMessageId }
      }
      let end
      try {
        if (attempt.state === 'writing') {
          // 原生队列不会按客户端 ID 去重。回执不明确时只查询原生记录。
          const result = await withCodexReader(socketPath, signal, rpc =>
            waitForFirstReceipt(signal, () => recover(rpc, attempt.thread, clientUserMessageId)))
          if (result) return await finish(result)
          throw new Error('原生记录暂未确认此次提交。')
        }
        attempt.fingerprint = fingerprint
        if (attempt.thread) {
          const { id } = attempt.thread
          await withCodexReader(socketPath, signal, rpc => rpc('thread/read', { threadId: id })).catch(error => {
            // 只有从未接纳提交的空线程可以在卸载后重新创建。
            if (!(error instanceof CodexRpcError) || !/not loaded|not found|no rollout|does not exist/i.test(error.message)) throw error
            attempt.thread = undefined
            attempt.permission = undefined
          })
        }
        if (!attempt.thread) await createThread(attempt, cwd, projectId, worktree, modelDraft, permissionDraft, signal)
        end = permissions?.holdCreation(attempt.thread.id)
        const write = async (rpc, method, params) => {
          attempt.permission = permissions?.readDraftPermission(attempt.thread.id) ?? attempt.permission
          attempt.state = 'writing'
          try {
            return await rpc(method, params)
          } catch (error) {
            if (explicitlyRejected(error)) attempt.state = 'ready'
            throw error
          }
        }
        return await finish(await submit(attempt.thread.id, () => execute(attempt.thread, write, attempt.permission)))
      } catch (error) {
        if (attempt.state === 'opening' || attempt.state === 'writing') throw await submissionConflict(attempt)
        throw error
      } finally {
        if (attempt.thread) permissions?.releaseCreation(attempt.thread.id)
        end?.()
        attempt.inProgress = false
        for (const [id, record] of attempts) {
          if (attempts.size <= 128) break
          if (!record.inProgress) attempts.delete(id)
        }
      }
    })
  }
}
