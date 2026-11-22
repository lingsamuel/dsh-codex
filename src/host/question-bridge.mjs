import { randomUUID } from 'node:crypto'
import { openCodexReader } from './app-server.mjs'
import { approvalResponse, hydrateFileApproval, projectApprovalRequest } from './approval-requests.mjs'

const isWaiting = status => status?.type === 'active'
  && status.activeFlags?.some(flag => flag === 'waitingOnUserInput' || flag === 'waitingOnApproval')
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

/** 为正在查看且等待用户操作的线程建立一次短期订阅，转交原生问答和审批。 */
export function createQuestionBridge(socketPath, ownerSignal) {
  const watched = new Map()

  function frame(state, type) {
    return { type, requests: [...state.requests.values()].filter(entry => entry.type === type).map(entry => entry.request) }
  }

  function publish(state, type) {
    const current = frame(state, type)
    for (const listener of state.listeners) listener(current)
  }

  function clearRequests(state) {
    const types = new Set([...state.requests.values()].map(entry => entry.type))
    state.requests.clear()
    state.submitting.clear()
    for (const type of types) publish(state, type)
  }

  function release(state) {
    clearTimeout(state.retry)
    state.retry = undefined
    state.subscription?.abort()
    clearRequests(state)
  }

  function publishRequest(state, id, type, request) {
    const entry = { type, request: { ...request, requestId: id, ...(type === 'approvals' && { key: randomUUID() }) } }
    state.requests.set(id, entry)
    publish(state, type)
    if (request.kind !== 'file-change') return

    // 文件审批请求只携带关联 itemId。尽量读回这项原生变更，供用户在确认前核对。
    const { threadId, turnId, itemId } = request
    void state.connection.request('thread/items/read', { threadId, turnId, itemIds: [itemId] }).then(({ data }) => {
      const change = data?.find(({ item }) => item.id === itemId && item.type === 'fileChange')?.item
      if (state.requests.get(id) !== entry) return
      const hydrated = hydrateFileApproval(entry.request, change?.changes)
      if (!hydrated) return
      entry.request = hydrated
      publish(state, type)
    }).catch(() => {})
  }

  function receive(state, { id, method, params }) {
    if (params?.threadId !== state.threadId) return
    if (method === 'serverRequest/resolved') {
      const entry = state.requests.get(params.requestId)
      if (!entry) return
      state.requests.delete(params.requestId)
      state.submitting.delete(params.requestId)
      publish(state, entry.type)
      if (!state.waiting && !state.requests.size) release(state)
      return
    }
    if (method === 'thread/status/changed') {
      state.waiting = isWaiting(params.status)
      if (!state.waiting) release(state)
      return
    }
    if (!isRequestId(id) || state.requests.has(id)) return
    if (method === 'item/tool/requestUserInput') {
      const { questions } = params
      if (Array.isArray(questions) && questions.length) {
        publishRequest(state, id, 'questions', params)
      }
      return
    }
    const approval = projectApprovalRequest(method, params)
    if (approval) publishRequest(state, id, 'approvals', approval)
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
    for (const type of new Set([...state.requests.values()].map(entry => entry.type))) {
      listener(frame(state, type))
    }
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

  function replyRoute({ path, type, invalid, unavailable, mismatch, failed, resultFor }) {
    return {
      path: `/api/codex/${path}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
        const body = await request.json().catch(() => null)
        const { threadId, requestId } = body ?? {}
        if (typeof threadId !== 'string' || !threadId || !isRequestId(requestId)) return json({ error: invalid }, 400)
        const state = watched.get(threadId)
        const pending = state?.requests.get(requestId)
        if (pending?.type !== type || state.submitting.has(requestId)
          || (type === 'approvals' && body.key !== pending.request.key)) return json({ error: unavailable }, 409)
        const result = resultFor(pending.request, body)
        if (!result) return json({ error: mismatch }, 400)
        state.submitting.add(requestId)
        try {
          await state.connection.respond(requestId, result)
          return json({ submitted: true })
        } catch {
          if (state.requests.get(requestId) === pending) state.submitting.delete(requestId)
          return json({ error: failed }, 503)
        }
      },
    }
  }

  const route = replyRoute({
    path: 'question-answer', type: 'questions', invalid: '问答请求或答案格式无效。', unavailable: '该问题已处理或不再等待回答。',
    mismatch: '答案与当前问题不匹配。', failed: '无法向 Codex 发送答案。', resultFor(question, { answers }) {
      const valid = requestAnswers(question.questions, answers)
      return valid && { answers: valid }
    },
  })
  const approvalRoute = replyRoute({
    path: 'approval-decision', type: 'approvals', invalid: '审批请求格式无效。', unavailable: '该审批已处理或已结束。',
    mismatch: '该决定不适用于此审批。', failed: '无法向 Codex 提交审批决定。',
    resultFor: (approval, { decision }) => approvalResponse(approval, decision),
  })
  return { observe, route, approvalRoute }
}
