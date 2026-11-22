import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages } from '../../shared/pages.js'
import { readPage } from '../api.js'
import { openLiveWatch } from '../live-watch.js'
import { readInlineCodexAttachments, readInlineUserImages } from '../native-chat/attachments.js'
import { projectCodexTurns, projectUserContent } from '../native-chat/events.js'
import { createLiveTranscript } from '../native-chat/live.js'
import { remoteFailure } from './catalog.js'
import { subagentAddress } from './subagents.js'
import { messageAnchor } from './message-anchor.js'
import { modelSelectionOf } from '../../shared/model-selection.js'
import { permissionOf } from '../../shared/permissions.js'
import { planModeOf } from '../../shared/plan-mode.js'
import { userInputText } from '../../shared/user-input.js'
import { projectAsyncQuestions, projectNativeQuestions } from './native-questions.js'

const emptyProjection = { getSnapshot: () => undefined, subscribe: () => () => {} }
// 导航占位符独立于视图事件序号，加载完成后 DSH 会用真实锚点替换它。
const outlineSequenceStart = 2 ** 40

function pageBounds(entry) {
  return entry && { beforeSeq: entry.event.seq, beforeTurn: entry.event.data.turn }
}

/** 给原版聊天渲染器提供由会话引用持有的原生历史、状态和待发送队列。 */
export function createCodexHistory(ctx, thread, catalog, retention) {
  const controller = new AbortController()
  const { signal } = controller
  const address = subagentAddress(thread)
  const state = createSnapshotStore({
    sessionId: thread.id,
    historyMode: thread.historyMode,
    archived: Boolean(thread.archived),
    canAcceptDirectInput: thread.canAcceptDirectInput,
    pendingSubmissions: [],
    running: false,
    subagent: address ? { address } : null,
    removed: false,
    openState: 'loading',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: Boolean(thread.blank),
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
    goalRevision: 0,
    planMode: planModeOf(thread),
    planRevision: 0,
    live: { mode: 'connecting', status: thread.status, lastTurnStatus: undefined },
  })
  const events = createSnapshotStore({
    entries: [],
    hasMore: false,
    revision: 0,
    change: { kind: 'replace', entries: [] },
  })
  const transcript = createLiveTranscript()
  const attachments = new Map()
  let queueImages = new Map()
  let cancelledToolCalls = new Map()
  let turnWorkingDirectories = {}
  const outline = createSnapshotStore(undefined)
  const todos = createSnapshotStore(undefined)
  const contextPressure = createSnapshotStore(undefined)
  const queueStore = createSnapshotStore([])
  const inbox = createSnapshotStore({ 'next-turn': [], 'next-step': [] })
  const codexQuestions = createSnapshotStore([])
  const codexApprovals = createSnapshotStore([])
  const codexMcpRequests = createSnapshotStore([])
  const permissions = createSnapshotStore({ permission: thread.webPermission })
  let recordedTurnPermission
  let lastSavedPermission
  let receivedSavedPermission = false
  let lastSavedPlanMode
  let planRevisionAtConnect = 0
  const userQuestions = createSnapshotStore(projectNativeQuestions([]))
  const modelSelection = createSnapshotStore({ lastUsed: null, next: modelSelectionOf(thread) })
  const projections = new Map([['turnOutline', outline], ['todos', todos], ['contextPressure', contextPressure],
    ['modelSelection', modelSelection], ['inbox', inbox], ['codexQuestions', codexQuestions], ['userQuestions', userQuestions],
    ['codexApprovals', codexApprovals], ['codexMcpRequests', codexMcpRequests], ['permissions', permissions]])
  const outlineTargets = new Map()
  const rows = []
  let nextCursor
  let pending
  let queue = Promise.resolve()
  let opened = false
  let triedFallback = false
  let outlineRevision = 0
  let archiveRevision = 0
  let liveQuestions = []
  let watchingInteractions = false
  let itemCursor
  let markReady
  const ready = new Promise(resolve => { markReady = resolve })
  ctx.effect(() => () => {
    controller.abort()
    markReady()
  })

  function publish(prepended = false) {
    const previous = events.getSnapshot()
    const entries = rows.flatMap(row => row.entries)
    const hasMore = Boolean(nextCursor)
    const samePrefix = previous.entries.every((entry, index) => entry === entries[index])
    if (samePrefix && previous.entries.length === entries.length && previous.hasMore === hasMore) return
    let change = { kind: 'replace', entries }
    if (prepended) change = { kind: 'prepend', entries: entries.slice(0, entries.length - previous.entries.length) }
    else if (samePrefix && previous.entries.length && previous.hasMore === hasMore) {
      change = { kind: 'append', entries: entries.slice(previous.entries.length) }
    }
    events.set({ entries, hasMore, revision: previous.revision + 1, change })
  }

  function publishState({ mode, status, historyMode, canAcceptDirectInput, archived } = {}) {
    if (archived !== undefined) archiveRevision++
    const lastTurn = transcript.getTurn(rows.at(-1)?.id)
    state.update(current => {
      if (mode !== undefined) current.live.mode = mode
      if (status !== undefined) current.live.status = status
      if (historyMode !== undefined) current.historyMode = historyMode
      if (canAcceptDirectInput !== undefined) current.canAcceptDirectInput = canAcceptDirectInput
      if (archived !== undefined) current.archived = Boolean(archived)
      current.live.lastTurnStatus = lastTurn?.status
      current.live.activeTurnId = lastTurn?.status === 'inProgress' ? lastTurn.id : undefined
      // 线程状态与已保存轮次各自到达。只有两者都确认运行时，输入栏才能对该轮插话。
      current.running = (current.live.mode === 'live' || current.live.mode === 'history')
        && current.live.status?.type === 'active' && current.live.activeTurnId !== undefined
      current.live.turnPermission = current.running && recordedTurnPermission?.turnId === current.live.activeTurnId
        ? recordedTurnPermission.permission : undefined
      current.hasMore = Boolean(nextCursor)
      if (lastTurn) current.blank = false
      if (opened) {
        current.openState = 'open'
        current.openError = null
      }
    })
    publishQuestions()
  }

  function applyThread(native) {
    publishState(native)
    publishModel(modelSelectionOf(native))
    if (native.status) catalog?.setStatus(thread.id, native.status)
  }

  function publishReadingReceipt(readState) {
    const row = rows.findLast(entry => entry.entries.at(-1)?.event.type === 'turn/end')
    const end = row?.entries.at(-1)?.event
    const newest = row?.entries.findLast(({ event }) => messageAnchor(event))?.event
    // Codex 的失败结果也可能产生未读。错误行可见之前，旧提示词不能代表已看到结果。
    const target = end?.data.reason.kind === 'error' ? { kind: 'turn-error', id: String(end.data.turn) }
      : newest && messageAnchor(newest)
    state.update(current => { current.reading = readState ? { readState, target } : undefined })
  }

  function publishModel(selection) {
    const previous = modelSelection.getSnapshot().next
    if ((previous && selection && previous.provider === selection.provider && previous.model === selection.model
      && previous.reasoningEffort === selection.reasoningEffort) || previous === selection) return
    modelSelection.set({ lastUsed: null, next: selection })
  }

  function publishPermission(permission) {
    if (permission && JSON.stringify(permissions.getSnapshot().permission) !== JSON.stringify(permission)) {
      permissions.set({ permission })
    }
  }

  /** 命令回执与旁路通知可能交错。提交后的更新只填补期间没有收到的确认。 */
  function publishPlanMode(mode, expectedRevision = state.getSnapshot().planRevision) {
    if (!mode || expectedRevision !== state.getSnapshot().planRevision) return
    state.update(current => { current.planMode = mode; current.planRevision++ })
  }

  function publishGoal(goal, expectedRevision = state.getSnapshot().goalRevision) {
    if (expectedRevision !== state.getSnapshot().goalRevision) return
    state.update(current => { current.goal = goal; current.goalRevision++ })
  }

  async function collectAttachments(turns) {
    const loaded = await readInlineCodexAttachments(turns, signal)
    signal.throwIfAborted()
    for (const [id, entry] of loaded) attachments.set(id, entry)
  }

  function project(turns, options) {
    return projectCodexTurns(turns, { provider: thread.modelProvider, createdAt: thread.createdAt, attachments, cancelledToolCalls, turnWorkingDirectories, ...options })
  }

  async function addOlderPage(page) {
    const turns = mergePages([], page.data.toReversed())
      .filter(turn => !transcript.getTurn(turn.id))
      .map(turn => transcript.reconcile(turn))
    await collectAttachments(turns)
    const pageEntries = project(turns, pageBounds(rows[0]?.entries[0]))
    const older = []
    for (const entry of pageEntries) {
      if (entry.event.type === 'turn/start') older.push({ id: entry.event.data.codexTurnId, entries: [] })
      older.at(-1).entries.push(entry)
    }
    rows.unshift(...older)
    nextCursor = page.nextCursor
  }

  async function updateTurn(turn, updates = turn.items ?? []) {
    const previous = transcript.getTurn(turn.id)
    const next = transcript.reconcile(turn, updates)
    if (!next) return
    const changedItems = next.items.filter((item, index) => item !== previous?.items[index])
    await collectAttachments([{ items: changedItems }])
    renderTurn(next)
  }

  function renderTurn(next) {
    const index = rows.findIndex(row => row.id === next.id)
    const existing = rows[index]?.entries
    const tail = rows.at(-1)?.entries
    const options = tail && {
      firstSeq: existing?.[0].event.seq ?? tail.at(-1).event.seq + 1,
      beforeTurn: existing ? existing[0].event.data.turn + 1 : tail[0].event.data.turn + 2,
    }
    // 尽量沿用已经发布的事件对象。原生窗口仅追加记录时，DSH 无需重新装配历史。
    const entries = project([next], options).map((entry, offset) => {
      const current = existing?.[offset]
      return current && JSON.stringify(current) === JSON.stringify(entry) ? current : entry
    })
    if (index < 0) {
      rows.push({ id: next.id, entries })
      return
    }
    rows[index] = { id: next.id, entries }
    const following = rows[index + 1]
    if (!following) return
    const overlap = entries.at(-1).event.seq - following.entries[0].event.seq + 1
    if (overlap <= 0) return
    for (const row of rows.slice(index + 1)) {
      row.entries = row.entries.map(entry => ({ ...entry, event: { ...entry.event, seq: entry.event.seq + overlap } }))
    }
  }

  function publishCancelledToolCalls(calls) {
    if (!calls) return
    const previous = cancelledToolCalls
    cancelledToolCalls = Map.groupBy(calls, call => call.turnId)
    let changed = false
    for (const id of new Set([...previous.keys(), ...cancelledToolCalls.keys()])) {
      if (JSON.stringify(previous.get(id)) === JSON.stringify(cancelledToolCalls.get(id))) continue
      const turn = transcript.getTurn(id)
      if (!turn) continue
      renderTurn(turn)
      changed = true
    }
    if (changed) publish()
  }

  function publishTurnDirectories(directories) {
    if (!directories) return
    const before = turnWorkingDirectories
    turnWorkingDirectories = directories
    let changed = false
    for (const { id } of rows) {
      if (before[id] === directories[id]) continue
      const turn = transcript.getTurn(id)
      if (!turn) continue
      renderTurn(turn)
      changed = true
    }
    if (changed) publish()
  }

  async function loadPage(cursor, lifetime = signal) {
    const page = await readPage('turns', { threadId: thread.id, ...(cursor ? { cursor } : {}) }, lifetime)
    lifetime.throwIfAborted()
    return page
  }

  async function refreshOutline() {
    const anchor = rows[0]?.entries[0]?.event.data.turn
    const cursor = nextCursor
    const revision = ++outlineRevision
    outlineTargets.clear()
    outline.set(undefined)
    if (!state.getSnapshot().historyMode || anchor === undefined || !cursor) return
    try {
      const earlier = await readPage('turn-outline', { threadId: thread.id, cursor }, signal)
      if (signal.aborted || revision !== outlineRevision) return
      outline.set(earlier.map(({ id, prompt, response }, index) => {
        const turn = anchor - index - 1
        const seq = outlineSequenceStart + turn
        outlineTargets.set(seq, id)
        return { turn, seq, prompt, response }
      }).reverse())
    } catch {
      // 原生导航仍可使用已加载的轮次。
    }
  }

  function clearHistory() {
    for (const { id } of rows) transcript.forgetTurn(id)
    rows.length = 0
    attachments.clear()
  }

  async function receiveSnapshot({ page, status, mode, readState, historyMode, selection, planMode, canAcceptDirectInput, archived, threadSummary, replace }, lifetime = signal) {
    if (!opened || replace) {
      if (replace) clearHistory()
      await addOlderPage(page)
      opened = true
    } else {
      let recent = mergePages([], page.data.toReversed())
      let cursor = page.nextCursor
      // 重连跨过整页时，按游标补齐两个窗口之间的轮次，已经载入的旧页继续保留。
      while (rows.length && recent.length && cursor && !recent.some(turn => transcript.getTurn(turn.id))) {
        const earlier = await loadPage(cursor, lifetime)
        recent = mergePages(earlier.data.toReversed(), recent)
        if (earlier.nextCursor === cursor) break
        cursor = earlier.nextCursor
      }
      const start = recent.findIndex(turn => transcript.getTurn(turn.id))
      const refreshed = recent.slice(Math.max(start, 0))
      const anchor = recent.length ? rows.findIndex(row => row.id === recent[start]?.id) : 0
      if (anchor < 0) {
        // 断线期间整个已加载窗口可能被回退。游标已找不到交集时从实际快照重建。
        clearHistory()
        nextCursor = cursor
      } else {
        // 最新快照可能来自 CLI 回退。只移除刷新窗口中的失效轮次，保留其前面的已加载历史。
        const currentIds = new Set(refreshed.map(turn => turn.id))
        for (let index = rows.length - 1; index >= anchor; index--) {
          if (currentIds.has(rows[index].id)) continue
          transcript.forgetTurn(rows[index].id)
          rows.splice(index, 1)
        }
      }
      if (!rows.length) nextCursor = cursor
      for (const turn of refreshed) await updateTurn(turn)
    }
    publish()
    // 已开始合并的轮次保留在缓存中，旧连接不能在释放后更新实时状态或阅读回执。
    if (lifetime.aborted) return
    publishState({ mode, status, historyMode, canAcceptDirectInput, archived })
    if (threadSummary) publishThreadSummary(threadSummary)
    if (selection !== undefined) publishModel(selection)
    if (planMode && planMode !== state.getSnapshot().planMode) publishPlanMode(planMode)
    todos.set(undefined)
    contextPressure.set(undefined)
    if (status) catalog?.setStatus(thread.id, status)
    publishReadingReceipt(readState)
    if (readState !== undefined) {
      if (replace) catalog?.setReadState(thread.id, readState)
      else catalog?.seedReadState(thread.id, readState)
    }
    markReady()
    void refreshOutline()
  }

  function fail(error) {
    if (signal.aborted) return
    state.update(current => {
      current.openError = remoteFailure(error.message)
      current.openState = 'error'
    })
    markReady()
  }

  function enqueue(operation, lifetime = signal) {
    queue = queue.then(() => { if (!lifetime.aborted) return operation() }).catch(error => {
      if (!lifetime.aborted) fail(error)
    })
    return queue
  }

  function publishQuestions() {
    const { archived, canAcceptDirectInput } = state.getSnapshot()
    const latest = transcript.getTurn(rows.at(-1)?.id)
    const asynchronous = archived || canAcceptDirectInput === false ? [] : projectAsyncQuestions(latest, queueStore.getSnapshot())
    const requests = [...liveQuestions, ...asynchronous]
    if (JSON.stringify(requests) === JSON.stringify(codexQuestions.getSnapshot())) return
    codexQuestions.set(requests)
    userQuestions.set(projectNativeQuestions(requests))
  }

  function publishThreadSummary(summary) {
    // 线程读取不会报告归档筛选的标签。保留目录已确认的归档状态。
    catalog?.acceptThread({ ...summary, ...(state.getSnapshot().archived && { archived: true }) })
  }

  async function publishQueue(submissions, lifetime) {
    const images = await Promise.all(submissions.map(({ id, input }) => readInlineUserImages(`queue:${id}`, input, lifetime, queueImages)))
    lifetime.throwIfAborted()
    // 待发缩略图只跟随当前队列，正文的原生图片缓存由历史引用持有。
    queueImages = new Map(images.flat().filter(Boolean))
    inbox.set({ 'next-turn': submissions.map(({ id, input, clientUserMessageId }) => ({ id, role: 'user',
      source: { kind: 'user', rpcId: clientUserMessageId }, content: projectUserContent(`queue:${id}`, input, queueImages),
    })), 'next-step': [] })
    queueStore.set(submissions)
    publishQuestions()
  }

  /** 主动查看带回原生队列。重连尚未送达时补齐界面，原生较新的推送仍优先。 */
  function captureQueueView() {
    const queueBefore = queueStore.getSnapshot()
    const archiveBefore = archiveRevision
    const catalogBefore = catalogArchiveRevision
    return submissions => enqueue(async () => {
      const summary = catalogThread(visibleCatalog?.getSnapshot())
      if ((archiveRevision !== archiveBefore && state.getSnapshot().archived)
        || (catalogArchiveRevision !== catalogBefore && summary?.archived)) return
      if (state.getSnapshot().archived) publishState({ archived: false })
      if (summary?.archived) catalog.acceptThread({ ...summary, archived: false })
      if (queueStore.getSnapshot() === queueBefore) await publishQueue(submissions, signal)
    })
  }

  function receive(frame, lifetime) {
    return enqueue(async () => {
      if (frame.type === 'snapshot') return receiveSnapshot(frame, lifetime)
      if (frame.type === 'model-selection') return publishModel(frame.selection)
      if (frame.type === 'questions' && watchingInteractions) {
        liveQuestions = frame.requests
        return publishQuestions()
      }
      if (frame.type === 'approvals' && watchingInteractions) return codexApprovals.set(frame.requests)
      if (frame.type === 'mcp-requests' && watchingInteractions) return codexMcpRequests.set(frame.requests)
      if (frame.type === 'thread-summary') return publishThreadSummary(frame.thread)
      if (frame.type === 'queue') return publishQueue(frame.submissions, lifetime)
      if (frame.type === 'reading-receipt') {
        publishReadingReceipt(frame.readState)
        return
      }
      if (frame.type === 'unread') return catalog?.applyUnread(frame)
      if (frame.type === 'rollout-facts') {
        todos.set(frame.todos)
        contextPressure.set(frame.contextPressure)
        publishCancelledToolCalls(frame.cancelledToolCalls)
        publishTurnDirectories(frame.turnWorkingDirectories)
        if (JSON.stringify(recordedTurnPermission) !== JSON.stringify(frame.turnPermission)) {
          recordedTurnPermission = frame.turnPermission
          publishState()
        }
        const recorded = frame.permission
        if (recorded) {
          const saved = JSON.stringify(recorded)
          const { permission: current } = permissions.getSnapshot()
          // 初次历史扫描可晚于本次切换；之后仅在最新落盘设置改变时更新。
          if (saved !== lastSavedPermission && (current?.source !== 'runtime' || (receivedSavedPermission
            && (current.profileId !== recorded.profileId
              || (recorded.approvalPolicy && current.approvalPolicy !== recorded.approvalPolicy)
              || (recorded.approvalsReviewer && current.approvalsReviewer !== recorded.approvalsReviewer))))) publishPermission(recorded)
          lastSavedPermission = saved
          receivedSavedPermission = true
        }
        if (frame.planMode) {
          // 重连后的首次检查点可以补齐断线期间的变化，仍须让位给这次连接后已经收到的确认。
          const initial = lastSavedPlanMode === undefined
          if (frame.planMode !== lastSavedPlanMode && (!initial || state.getSnapshot().planRevision === planRevisionAtConnect)) {
            publishPlanMode(frame.planMode)
          }
          lastSavedPlanMode = frame.planMode
        }
        return
      }
      if (frame.type === 'change') {
        if (frame.onlyIfLoaded && !transcript.getTurn(frame.turn.id)) return
        await updateTurn(frame.turn, frame.items)
        publish()
        publishState()
      } else if (frame.type === 'notification') {
        const { method, params } = frame.notification
        if (method === 'thread/started' && params.thread?.id === thread.id) {
          applyThread(params.thread)
        } else if (method === 'thread/status/changed') {
          if (params.threadId === thread.id) publishState({ status: params.status })
          catalog?.setStatus(params.threadId, params.status)
        } else if (method === 'thread/readState/changed') {
          catalog?.setReadState(params.threadId, params.readState)
        } else if (method === 'thread/settings/updated') {
          const { effort, ...settings } = params.threadSettings
          publishModel(modelSelectionOf({ ...settings, reasoningEffort: effort }))
          publishPermission(permissionOf(settings))
          publishPlanMode(planModeOf(settings))
        } else if (method === 'thread/archived' || method === 'thread/unarchived') {
          publishState({ archived: method === 'thread/archived' })
        } else if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
          publishGoal(params.goal ?? null)
        }
      }
    }, lifetime)
  }

  function changeMode(mode, lifetime) {
    return enqueue(async () => {
      // 新连接会重新扫描 rollout，旧文件被替换时不保留上一连接的补充条目。
      if (mode === 'connecting') {
        publishCancelledToolCalls([])
        recordedTurnPermission = undefined
        lastSavedPlanMode = undefined
        planRevisionAtConnect = state.getSnapshot().planRevision
      }
      if (mode === 'disconnected') {
        liveQuestions = []
        codexApprovals.set([])
        codexMcpRequests.set([])
      }
      publishState({ mode })
      if (mode !== 'disconnected' || opened || triedFallback) return
      triedFallback = true
      try {
        const page = await loadPage(undefined, lifetime)
        await receiveSnapshot({ page, mode: 'history' }, lifetime)
      } finally {
        if (lifetime.aborted) triedFallback = false
      }
    }, lifetime)
  }

  function loadOlder() {
    if (pending) return pending
    if (!nextCursor && state.getSnapshot().openState !== 'error') return Promise.resolve()
    pending = enqueue(async () => {
      state.update(current => { current.loadingOlder = true })
      try {
        if (!opened) await receiveSnapshot({ page: await loadPage(), mode: 'history' })
        else if (nextCursor) {
          await addOlderPage(await loadPage(nextCursor))
          publish(true)
          publishState()
        }
      } finally {
        if (!signal.aborted) state.update(current => { current.loadingOlder = false })
      }
    }).finally(() => { pending = undefined })
    return pending
  }

  async function loadThrough(seq) {
    const turnId = outlineTargets.get(seq)
    if (turnId) {
      await loadTurn(turnId)
      return
    }
    while (!signal.aborted && nextCursor && events.getSnapshot().entries[0]?.event.seq > seq) {
      const cursor = nextCursor
      await loadOlder()
      if (cursor === nextCursor) return
    }
  }

  async function loadTurn(turnId, requestSignal = signal) {
    await ready
    while (!signal.aborted && !requestSignal.aborted) {
      const row = rows.find(turn => turn.id === turnId)
      if (row) return row
      const cursor = nextCursor
      if (!cursor) return
      await loadOlder()
      if (cursor === nextCursor) return
    }
  }

  /** 定位命中消息，沿用聊天的历史页和现有阅读窗口。 */
  async function findMessage({ turnId, itemId }, requestSignal) {
    const row = await loadTurn(turnId, requestSignal)
    for (const { event } of row?.entries ?? []) {
      if ((event.data.message?.id ?? event.data.id) !== itemId) continue
      const anchor = messageAnchor(event)
      if (anchor) return anchor
    }
  }

  function turnAtEnd(seq) {
    return rows.find(({ entries }) => {
      const { event } = entries.at(-1)
      return event.type === 'turn/end' && event.seq === seq
    })?.id
  }

  function rowAtTurn(turn) {
    return rows.find(({ entries }) => entries[0].event.data.turn === turn)
  }

  function finishedTurnOfReply(messageId) {
    return rows.find(({ entries }) => entries.at(-1).event.type === 'turn/end' && entries.some(({ event }) =>
      event.type === 'assistant/message' && event.data.message.id === messageId))?.id
  }

  function latestTurnId() {
    return rows.at(-1)?.id
  }

  function editableInput(turn, sequence) {
    const row = rowAtTurn(turn)
    const source = transcript.getTurn(row?.id)
    if (!source || source.status === 'inProgress') return
    const input = row.entries.find(({ event }) => event.type === 'user/message')?.event
    const message = source.items.find(item => item.type === 'userMessage')
    // 问答可在轮首投影为问答卡，后续第一个可见的普通气泡仍然属于插话。
    if (!message || input?.seq !== sequence || input?.data.id !== message.id) return
    return { beforeTurnId: source.id, itemId: message.id, text: userInputText(message.content), headTurnId: latestTurnId(),
      hasAttachments: message.content.some(part => part.type !== 'text') }
  }

  const visibleCatalog = catalog?.store
  const catalogThread = snapshot => snapshot?.childThreads?.[thread.id] ?? snapshot?.threads?.find(summary => summary.id === thread.id)
  let catalogArchived = Boolean(catalogThread(visibleCatalog?.getSnapshot())?.archived)
  let catalogArchiveRevision = 0
  let watch
  function syncWatch() {
    if (signal.aborted) return
    const snapshot = visibleCatalog?.getSnapshot()
    const archived = Boolean(catalogThread(snapshot)?.archived)
    if (archived !== catalogArchived) {
      catalogArchived = archived
      catalogArchiveRevision++
    }
    const connected = !retention || Boolean(retention.getSnapshot().connectionCount)
    const selected = connected && (!visibleCatalog || snapshot?.selected?.id === thread.id)
    if (Boolean(watch) === connected && selected === watchingInteractions) return
    watchingInteractions = selected
    watch?.abort()
    const nextWatch = connected ? new AbortController() : undefined
    watch = nextWatch
    triedFallback = false
    if (!selected) {
      liveQuestions = []
      codexApprovals.set([])
      codexMcpRequests.set([])
    }
    if (!nextWatch) {
      publishState({ mode: 'disconnected' })
      return
    }
    if (!selected) publishQuestions()
    // 队列可能还在等上一帧的异步读取。让已排队的帧携带自己的连接寿命，防止切回时显示旧审批。
    const lifetime = AbortSignal.any([signal, nextWatch.signal])
    openLiveWatch(thread.id, {
      receive: frame => receive(frame, lifetime), changeMode: mode => changeMode(mode, lifetime),
      queue: true, questions: selected, itemCursor,
      // 暂停后只从已完成投影的条目继续，仍在排队的旧帧会随旧连接取消。
      checkpoint: cursor => enqueue(() => { itemCursor = cursor }, lifetime),
    }, lifetime)
  }
  if (visibleCatalog || retention) {
    ctx.effect(() => {
      const stopCatalog = visibleCatalog?.subscribe(syncWatch)
      const stopRetention = retention?.subscribe(syncWatch)
      queueMicrotask(syncWatch)
      return () => { stopCatalog?.(); stopRetention?.(); watch?.abort() }
    })
  } else syncWatch()
  return {
    events,
    ready,
    activeTurnId: () => state.getSnapshot().running ? state.getSnapshot().live.activeTurnId : undefined,
    queueStore,
    captureQueueView,
    updateState: edit => state.update(edit),
    session: {
      getSnapshot: state.getSnapshot,
      subscribe: state.subscribe,
      loadOlder,
      loadThrough,
      findMessage,
      turnAtEnd,
      finishedTurnOfReply,
      latestTurnId,
      editableInput,
      publishModel,
      publishPermission,
      publishPlanMode,
      publishGoal,
      projections: { faceOf: key => projections.get(key) ?? emptyProjection },
      queuedImageUrl: id => queueImages.get(id)?.url,
      async readAttachment({ attachmentId }) {
        const value = attachments.get(attachmentId)
        return value
          ? { ok: true, value: { attachment: value.attachment, data: value.data } }
          : { ok: false, error: remoteFailure('此附件无法从 Codex 历史接口读取。') }
      },
    },
  }
}
