import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { readBackgroundTerminals } from './background-terminals.mjs'
import { readWorktreeOptions, requireWorktreeDestination, worktreeConflict } from './git-worktrees.mjs'
import { addressableThread, createThreadSubmissionQueue, readConversationQueue, resumeThread } from './thread-runtime.mjs'
import { resolveWorkspacePaths } from './workspace-paths.mjs'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

function requireIdle(thread, expectedCwd, allowCold = false) {
  if (thread.cwd !== expectedCwd) throw worktreeConflict('worktree-cwd-changed', '会话目录已变化，请重新选择。')
  if (thread.status?.type === 'idle' || (allowCold && thread.status?.type === 'notLoaded')) return
  throw worktreeConflict('worktree-active', '请先结束当前轮次，再切换工作目录。')
}

async function changeDirectory(rpc, threadId, cwd, expectedCwd, signal) {
  const current = await addressableThread(rpc, threadId)
  requireIdle(current, expectedCwd, true)
  const target = await requireWorktreeDestination(current.cwd, cwd, signal)
  if (current.cwd === target) return current
  if ((await readConversationQueue(rpc, threadId)).length) {
    throw worktreeConflict('worktree-queue', '请先发送或移除待发消息，再切换工作目录。')
  }
  const loaded = await resumeThread(rpc, current)
  requireIdle(loaded, expectedCwd)
  // 恢复与 Git 查询都可能跨越其他客户端的提交。写入前检查原生队列、后台进程及活动状态。
  const [queue, terminals] = await Promise.all([readConversationQueue(rpc, threadId), readBackgroundTerminals(rpc, threadId)])
  if (queue.length) throw worktreeConflict('worktree-queue', '请先发送或移除待发消息，再切换工作目录。')
  if (terminals.length) throw worktreeConflict('worktree-background', '请先结束后台进程，再切换工作目录。')
  requireIdle(await addressableThread(rpc, threadId), expectedCwd)
  await rpc('thread/settings/update', { threadId, cwd: target })

  // 原生更新回执为空。工作目录真正生效后才能刷新文件索引和页面摘要。
  const deadline = performance.now() + 3_000
  do {
    const thread = await addressableThread(rpc, threadId)
    if (thread.cwd === target) return thread
    if (thread.cwd !== expectedCwd) break
    await delay(40, undefined, { signal })
  } while (performance.now() < deadline)
  throw worktreeConflict('worktree-cwd-unconfirmed', 'Codex 尚未确认切换结果，请刷新后查看工作目录。')
}

/** 读取工作树选项，或在与会话提交共用的串行入口内修改原生工作目录。 */
export function createWorktreeRoutes(socketPath, ownerSignal, submit = createThreadSubmissionQueue()) {
  const signalFor = request => ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
  function failure(error) {
    if (error instanceof CodexRpcError) {
      const reason = error.data?.reason
      return json({ error: error.message, ...(reason && { reason }) }, reason ? 409 : error.code === -32602 ? 400 : 502)
    }
    return json({ error: '无法确认 Git 工作树或 Codex 会话的状态。' }, 503)
  }

  return [{
    path: '/api/codex/worktrees', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const cwd = new URL(request.url).searchParams.get('cwd')
        return json(await readWorktreeOptions(cwd, signalFor(request)))
      } catch (error) {
        return failure(error)
      }
    },
  }, {
    path: '/api/codex/worktree-action', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const { threadId, cwd, expectedCwd } = (await request.json().catch(() => null)) ?? {}
      if (typeof threadId !== 'string' || !threadId.trim() || typeof cwd !== 'string' || !isAbsolute(cwd)
        || typeof expectedCwd !== 'string' || !isAbsolute(expectedCwd)) return json({ error: '缺少有效的工作目录或会话 ID。' }, 400)
      const signal = signalFor(request)
      try {
        const thread = await submit(threadId, () => withCodexReader(socketPath, signal, rpc => changeDirectory(rpc, threadId, cwd, expectedCwd, signal)))
        return json({ thread, workspacePaths: await resolveWorkspacePaths([thread.cwd]) })
      } catch (error) {
        return failure(error)
      }
    },
  }]
}
