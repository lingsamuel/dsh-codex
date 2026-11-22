import { openCodexReader } from './app-server.mjs'

const isWaiting = status => status?.type === 'active' && status.activeFlags?.includes('waitingOnUserInput')
const isRequestId = value => (typeof value === 'string' && value.length > 0) || Number.isSafeInteger(value)
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

function requestAnswers(questions, answers) {
  if (!isObject(answers)) return
  const ids = new Set(questions.map(question => question.id))
  const entries = Object.entries(answers)
  if (entries.some(([id, answer]) => !ids.has(id) || !Array.isArray(answer?.answers)
    || answer.answers.some(text => typeof text !== 'string'))) return
  return Object.fromEntries(entries.map(([id, { answers }]) => [id, { answers }]))
}

/** 为正在查看且等待回答的线程建立短期订阅，从原生请求重放取得题目并转交答复。 */
export function createQuestionBridge(socketPath, ownerSignal) {
  const watched = new Map()

  function frame(state) {
    return { type: 'questions', requests: [...state.requests.values()] }
  }

  function publish(state) {
    const current = frame(state)
    for (const listener of state.listeners) listener(current)
  }

  function clearRequests(state) {
    if (!state.requests.size) return
    state.requests.clear()
    state.submitting.clear()
    publish(state)
  }

  function release(state) {
    clearTimeout(state.retry)
    state.retry = undefined
    state.subscription?.abort()
    clearRequests(state)
  }

  function receive(state, { id, method, params }) {
    if (params?.threadId !== state.threadId) return
    if (method === 'item/tool/requestUserInput') {
      const { questions } = params
      // DSH 的问答面板会在本地保存答复。要求保密的请求仍可在 Codex CLI 作答。
      if (!isRequestId(id) || state.requests.has(id) || !Array.isArray(questions) || !questions.length
        || questions.some(question => question.isSecret)) return
      state.requests.set(id, { ...params, requestId: id })
      publish(state)
    } else if (method === 'serverRequest/resolved' && state.requests.delete(params.requestId)) {
      state.submitting.delete(params.requestId)
      publish(state)
      if (!state.waiting && !state.requests.size) release(state)
    } else if (method === 'thread/status/changed') {
      state.waiting = isWaiting(params.status)
      if (!state.waiting) release(state)
    }
  }

  async function attach(state) {
    if (!state.waiting || !state.listeners.size || state.subscription || state.retry) return
    const subscription = new AbortController()
    state.subscription = subscription
    let connection
    try {
      connection = await openCodexReader(socketPath, subscription.signal, message => receive(state, message))
      state.connection = connection
      // 等待状态可能已变化。再次读回状态，避免恢复已离开的线程或把冷线程载入运行时。
      const { thread } = await connection.request('thread/read', { threadId: state.threadId })
      if (!isWaiting(thread.status) || thread.archived || thread.ephemeral || thread.canAcceptDirectInput === false) {
        state.waiting = false
        return
      }
      // 热恢复只附加当前连接。Codex 在回复后重放未解决请求，既有 CLI 连接仍可回答。
      await connection.request('thread/resume', { threadId: state.threadId, excludeTurns: true })
      await connection.closed
    } catch {
      // 订阅失败时保留独立的历史流，等待期间继续尝试重放。
    } finally {
      connection?.close()
      state.connection = undefined
      state.subscription = undefined
      clearRequests(state)
      if (state.waiting && state.listeners.size) {
        state.retry = setTimeout(() => {
          state.retry = undefined
          void attach(state)
        }, 1_000)
        state.retry.unref()
      }
    }
  }

  function observe(threadId, listener, signal) {
    const lifetime = ownerSignal ? AbortSignal.any([signal, ownerSignal]) : signal
    if (lifetime.aborted) return { update() {} }
    if (!watched.has(threadId)) {
      watched.set(threadId, { threadId, listeners: new Set(), requests: new Map(), submitting: new Set() })
    }
    const state = watched.get(threadId)
    state.listeners.add(listener)
    if (state.requests.size) listener(frame(state))
    lifetime.addEventListener('abort', () => {
      state.listeners.delete(listener)
      if (state.listeners.size) return
      watched.delete(threadId)
      release(state)
    }, { once: true })
    return {
      update(status) {
        if (lifetime.aborted) return
        state.waiting = isWaiting(status)
        if (state.waiting) void attach(state)
        // 被动流与订阅使用不同连接，已有请求仍由原生 resolved 通知关闭。
        else if (status == null || !state.requests.size) release(state)
      },
    }
  }

  const route = {
    path: '/api/codex/question-answer',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const type = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
      const { threadId, requestId, answers } = (await request.json().catch(() => null)) ?? {}
      if (typeof threadId !== 'string' || !threadId || !isRequestId(requestId) || !isObject(answers)) {
        return json({ error: '问答请求或答案格式无效。' }, 400)
      }
      const state = watched.get(threadId)
      const pending = state?.requests.get(requestId)
      if (!pending || state.submitting.has(requestId)) return json({ error: '该问题已处理或不再等待回答。' }, 409)
      const validAnswers = requestAnswers(pending.questions, answers)
      if (!validAnswers) return json({ error: '答案与当前问题不匹配。' }, 400)
      state.submitting.add(requestId)
      try {
        await state.connection.respond(requestId, { answers: validAnswers })
        return json({ submitted: true })
      } catch {
        return json({ error: '无法向 Codex 发送答案。' }, 503)
      }
    },
  }
  return { observe, route }
}
