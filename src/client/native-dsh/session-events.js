import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages } from '../../shared/pages.js'
import { readPage } from '../api.js'
import { openLiveWatch } from '../live-watch.js'
import { readInlineCodexAttachments } from '../native-chat/attachments.js'
import { projectCodexTurns } from '../native-chat/events.js'
import { createLiveTranscript } from '../native-chat/live.js'
import { remoteFailure } from './catalog.js'
import { subagentAddress } from './subagents.js'
import { messageAnchor } from './message-anchor.js'
import { modelSelectionOf } from '../../shared/model-selection.js'

const emptyProjection = { getSnapshot: () => undefined, subscribe: () => () => {} }
// 导航占位符独立于视图事件序号，加载完成后 DSH 会用真实锚点替换它。
const outlineSequenceStart = 2 ** 40

function pageBounds(entry) {
  return entry && { beforeSeq: entry.event.seq, beforeTurn: entry.event.data.turn }
}

/** 给原版聊天渲染器提供由会话引用持有的历史窗口和只读实时状态。 */
export function createCodexHistory(ctx, thread, catalog) {
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
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
    goalRevision: 0,
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
  const outline = createSnapshotStore(undefined)
  const todos = createSnapshotStore(undefined)
  const contextPressure = createSnapshotStore(undefined)
  const modelSelection = createSnapshotStore({ lastUsed: null, next: modelSelectionOf(thread) })
  const projections = new Map([['turnOutline', outline], ['todos', todos], ['contextPressure', contextPressure], ['modelSelection', modelSelection]])
  const outlineTargets = new Map()
  const rows = []
  let nextCursor
  let pending
  let queue = Promise.resolve()
  let opened = false
  let triedFallback = false
  let outlineRevision = 0
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

  function publishState({ mode, status, historyMode, canAcceptDirectInput } = {}) {
    const lastTurnStatus = transcript.getTurn(rows.at(-1)?.id)?.status
    state.update(current => {
      if (mode !== undefined) current.live.mode = mode
      if (status !== undefined) current.live.status = status
      if (historyMode !== undefined) current.historyMode = historyMode
      if (canAcceptDirectInput !== undefined) current.canAcceptDirectInput = canAcceptDirectInput
      current.live.lastTurnStatus = lastTurnStatus
      current.running = current.live.mode === 'live' && current.live.status?.type === 'active'
      current.hasMore = Boolean(nextCursor)
      if (opened) {
        current.openState = 'open'
        current.openError = null
      }
    })
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

  async function collectAttachments(turns) {
    const loaded = await readInlineCodexAttachments(turns, signal)
    signal.throwIfAborted()
    for (const [id, entry] of loaded) attachments.set(id, entry)
  }

  function project(turns, options) {
    return projectCodexTurns(turns, { provider: thread.modelProvider, createdAt: thread.createdAt, attachments, ...options })
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

    const index = rows.findIndex(row => row.id === turn.id)
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

  async function loadPage(cursor) {
    const page = await readPage('turns', { threadId: thread.id, ...(cursor ? { cursor } : {}) }, signal)
    signal.throwIfAborted()
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

  async function receiveSnapshot({ page, status, mode, readState, historyMode, selection, canAcceptDirectInput }) {
    if (!opened) {
      await addOlderPage(page)
      opened = true
    } else {
      let recent = mergePages([], page.data.toReversed())
      let cursor = page.nextCursor
      // 重连跨过整页时，按游标补齐两个窗口之间的轮次，已经载入的旧页继续保留。
      while (rows.length && recent.length && cursor && !recent.some(turn => transcript.getTurn(turn.id))) {
        const earlier = await loadPage(cursor)
        recent = mergePages(earlier.data.toReversed(), recent)
        if (earlier.nextCursor === cursor) break
        cursor = earlier.nextCursor
      }
      const start = recent.findIndex(turn => transcript.getTurn(turn.id))
      const refreshed = recent.slice(Math.max(start, 0))
      const anchor = recent.length ? rows.findIndex(row => row.id === recent[start]?.id) : 0
      if (anchor >= 0) {
        // 最新快照可能来自 CLI 回退。只移除刷新窗口中的失效轮次，保留其前面的已加载历史。
        const currentIds = new Set(refreshed.map(turn => turn.id))
        for (let index = rows.length - 1; index >= anchor; index--) {
          if (currentIds.has(rows[index].id)) continue
          transcript.forgetTurn(rows[index].id)
          rows.splice(index, 1)
        }
      }
      if (!rows.length) nextCursor = page.nextCursor
      for (const turn of refreshed) await updateTurn(turn)
    }
    publish()
    publishState({ mode, status, historyMode, canAcceptDirectInput })
    if (selection !== undefined) publishModel(selection)
    todos.set(undefined)
    contextPressure.set(undefined)
    if (status) catalog?.setStatus(thread.id, status)
    publishReadingReceipt(readState)
    if (readState !== undefined) catalog?.seedReadState(thread.id, readState)
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

  function enqueue(operation) {
    queue = queue.then(() => { if (!signal.aborted) return operation() }).catch(fail)
    return queue
  }

  function receive(frame) {
    return enqueue(async () => {
      if (frame.type === 'snapshot') return receiveSnapshot(frame)
      if (frame.type === 'model-selection') return publishModel(frame.selection)
      if (frame.type === 'reading-receipt') {
        publishReadingReceipt(frame.readState)
        return
      }
      if (frame.type === 'unread') return catalog?.applyUnread(frame)
      if (frame.type === 'rollout-facts') {
        todos.set(frame.todos)
        contextPressure.set(frame.contextPressure)
        return
      }
      if (frame.type === 'change') {
        await updateTurn(frame.turn, frame.items)
        publish()
        publishState()
      } else if (frame.type === 'notification') {
        const { method, params } = frame.notification
        if (method === 'thread/status/changed') {
          if (params.threadId === thread.id) publishState({ status: params.status })
          catalog?.setStatus(params.threadId, params.status)
        } else if (method === 'thread/readState/changed') {
          catalog?.setReadState(params.threadId, params.readState)
        } else if (method === 'thread/settings/updated') {
          const { effort, ...settings } = params.threadSettings
          publishModel(modelSelectionOf({ ...settings, reasoningEffort: effort }))
        } else if (method === 'thread/archived' || method === 'thread/unarchived') {
          state.update(current => { current.archived = method === 'thread/archived' })
        } else if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
          state.update(current => {
            current.goal = params.goal ?? null
            current.goalRevision++
          })
        }
      }
    })
  }

  function changeMode(mode) {
    return enqueue(async () => {
      publishState({ mode })
      if (mode !== 'disconnected' || opened || triedFallback) return
      triedFallback = true
      await receiveSnapshot({ page: await loadPage(), mode: 'history' })
    })
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
      if (event.type === 'user/message' && event.data.id === itemId) return messageAnchor(event)
      if (event.type === 'assistant/message' && event.data.message.id === itemId) return messageAnchor(event)
    }
  }

  openLiveWatch(thread.id, { receive, changeMode }, signal)
  return {
    events,
    ready,
    session: {
      getSnapshot: state.getSnapshot,
      subscribe: state.subscribe,
      loadOlder,
      loadThrough,
      findMessage,
      publishModel,
      projections: { faceOf: key => projections.get(key) ?? emptyProjection },
      async readAttachment(id) {
        const value = attachments.get(id)
        return value
          ? { ok: true, value }
          : { ok: false, error: remoteFailure('此附件无法从 Codex 历史接口读取。') }
      },
    },
  }
}
