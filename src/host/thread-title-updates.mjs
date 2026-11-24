import { questionReplies } from '../shared/question-replies.js'
import { userInputText } from '../shared/user-input.js'
import { iterateCodexPages, openCodexReader } from './app-server.mjs'
import { readThreadTurns } from './live-history.mjs'
import { readConversationQueue } from './thread-runtime.mjs'

const recentTurns = 6
const settleMs = 120

/** 首次拟标题及后续计数使用同一个原生起点，跳过没有用户消息的前置轮次。 */
export async function readFirstTitleMessage(request, threadId) {
  const pages = iterateCodexPages(cursor => readThreadTurns(request,
    { threadId, limit: 1, sortDirection: 'asc', itemsView: 'summary', cursor }))
  for await (const { data: [turn] } of pages) {
    const item = turn?.items.find(entry => entry.type === 'userMessage')
    if (item) return { turnId: turn.id, item, text: userInputText(item.content).trim() }
  }
}

function titleMessage(item) {
  if (item.type !== 'userMessage' || questionReplies(item.content)) return []
  const text = userInputText(item.content).trim()
  return text ? [{ id: item.id, clientId: item.clientId, text }] : []
}

/** 摘要只有首条用户消息。网页插话所在的轮次按原生页读取正文，其余轮次沿用摘要。 */
export async function readTitleContext(request, threadId, steeredTurns) {
  const { data } = await readThreadTurns(request, { threadId, limit: recentTurns, sortDirection: 'desc', itemsView: 'summary' })
  const context = []
  for (const { id, status, items } of data) {
    const messages = []
    if (steeredTurns.has(id)) {
      const pages = iterateCodexPages(cursor => request('thread/items/list', {
        threadId, turnId: id, limit: 32, sortDirection: 'asc', ...(cursor != null && { cursor }),
      }))
      for await (const page of pages) {
        for (const { item } of page.data) messages.push(...titleMessage(item))
      }
    } else messages.push(...items.flatMap(titleMessage))
    context.push({ id, status, messages })
  }
  return context
}

/** 只跟踪 DSH 已提交的原生标识，所有会话共享一个旁路连接。 */
export function createThreadTitleUpdates(socketPath, signal, checkTitle) {
  const threads = new Map()
  let connection

  function schedule(job, ms = settleMs) {
    if (signal.aborted || job.timer) return
    if (job.running) { job.dirty = true; return }
    job.timer = setTimeout(() => {
      job.timer = undefined
      job.running = true
      void inspect(job).catch(() => {
        if (job.pending.size && job.failures++ < 2) job.retry = 1_000
      }).finally(() => {
        job.running = false
        if (threads.get(job.id) !== job || signal.aborted) return
        const retry = job.retry
        job.retry = undefined
        if (job.dirty || retry) {
          job.dirty = false
          schedule(job, retry)
        }
      })
    }, ms)
    job.timer.unref()
  }

  function forget(job) {
    clearTimeout(job.timer)
    threads.delete(job.id)
  }

  function reader() {
    connection ??= openCodexReader(socketPath, signal, ({ id, method, params }) => {
      if (id !== undefined) return
      const job = threads.get(params?.threadId)
      if (!job) return
      if (method === 'thread/archived' || method === 'thread/deleted') forget(job)
      else if (method === 'thread/reverted' && job.rounds.size) {
        job.reverted = true
        schedule(job)
      }
      else if (job.pending.size && (method === 'thread/status/changed' || method === 'thread/queue/changed')) {
        job.failures = 0
        schedule(job)
      }
    }).then(open => {
      void open.closed.then(() => {
        connection = undefined
        for (const job of threads.values()) if (job.pending.size) schedule(job, 1_000)
      })
      return open.request
    }, error => {
      connection = undefined
      throw error
    })
    return connection
  }

  async function inspect(job) {
    const request = await reader()
    const { thread } = await request('thread/read', { threadId: job.id })
    if (thread.archived || thread.ephemeral || thread.canAcceptDirectInput === false) { forget(job); return }
    if (thread.status?.type !== 'idle') return
    const steeredTurns = new Set(job.steeredTurns)
    const context = await readTitleContext(request, job.id, steeredTurns)
    job.failures = 0
    if (context[0]?.status === 'inProgress') {
      const deadline = job.projectionDeadline ??= performance.now() + 1_000
      if (performance.now() < deadline) job.retry = settleMs
      return
    }
    job.projectionDeadline = undefined
    if (job.reverted) {
      job.reverted = false
      for (const turnId of job.rounds.keys()) {
        // 回退可只删除末尾内容，保留仍在原生历史中的已计轮次。
        if (context.some(turn => turn.id === turnId)) continue
        const { data } = await request('thread/items/list', { threadId: job.id, turnId, limit: 1 })
        if (!data.length) job.rounds.delete(turnId)
      }
    }
    const possibleFirst = [...job.pending.values()].some(entry => entry.first)
    const firstTurn = possibleFirst && (await readFirstTitleMessage(request, job.id))?.turnId
    for (const [key, entry] of job.pending) {
      for (const turn of context) {
        const matches = turn.messages.filter(message => entry.clientId ? message.clientId === entry.clientId : turn.id === entry.turnId)
        if (!matches.length) continue
        job.pending.delete(key)
        if (turn.id === firstTurn || job.checked.has(turn.id)) break
        const texts = job.rounds.get(turn.id) ?? new Map()
        for (const message of matches) texts.set(message.id, message.text)
        job.rounds.set(turn.id, texts)
        break
      }
    }

    if (job.pending.size) {
      // 领取待发项和提交历史可能先后完成。给刚登记的消息留一次短暂核对窗口。
      const queued = await readConversationQueue(request, job.id).catch(() => null)
      const queuedIds = new Set(queued?.map(item => item.clientUserMessageId))
      for (const [key, entry] of job.pending) {
        if (performance.now() < entry.expires) job.retry = settleMs
        else if (queued && !queuedIds.has(entry.clientId)) job.pending.delete(key)
      }
    }
    if (job.rounds.size < 2 || signal.aborted) return
    const anchor = context.find(turn => job.rounds.has(turn.id))?.id
    const text = [...job.rounds.values()].flatMap(messages => [...messages.values()]).join('')
    for (const id of job.rounds.keys()) job.checked.add(id)
    if (job.checked.size > recentTurns) job.checked = new Set([...job.checked].slice(-recentTurns))
    job.rounds.clear()
    if (anchor && [...text.replace(/[\s\p{P}]/gu, '')].length > 10) {
      await checkTitle(thread, context, steeredTurns, anchor, signal)
    }
  }

  signal.addEventListener('abort', () => {
    for (const job of threads.values()) clearTimeout(job.timer)
    threads.clear()
  }, { once: true })

  return (thread, clientId, turnId, steered) => {
    if (signal.aborted || (!clientId && !turnId)) return
    let job = threads.get(thread.id)
    if (!job) {
      job = { id: thread.id, pending: new Map(), rounds: new Map(), checked: new Set(), steeredTurns: new Set(), failures: 0 }
      threads.set(thread.id, job)
      if (threads.size > 512) {
        const idle = [...threads.values()].find(entry => !entry.pending.size && !entry.running && !entry.timer)
        if (idle) forget(idle)
      }
    }
    const key = clientId ?? turnId
    const first = job.pending.get(key)?.first || (!thread.name && !thread.preview)
    job.pending.set(key, { clientId, turnId, first, expires: performance.now() + 1_000 })
    if (steered && turnId) {
      job.steeredTurns.add(turnId)
      if (job.steeredTurns.size > recentTurns) job.steeredTurns = new Set([...job.steeredTurns].slice(-recentTurns))
    }
    job.failures = 0
    job.projectionDeadline = undefined
    schedule(job)
  }
}
