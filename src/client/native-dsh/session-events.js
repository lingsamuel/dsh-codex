import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mergePages } from '../../shared/pages.js'
import { readPage } from '../api.js'
import { readInlineCodexAttachments } from '../native-chat/attachments.js'
import { projectCodexTurns } from '../native-chat/events.js'
import { remoteFailure } from './catalog.js'

/** 给原生聊天渲染器提供由当前 Session 引用持有的 Codex 轮次窗口。 */
export function createCodexHistory(ctx, thread) {
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort())

  const state = createSnapshotStore({
    sessionId: thread.id,
    pendingSubmissions: [],
    running: false,
    subagent: null,
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
  })
  const events = createSnapshotStore({
    entries: [],
    hasMore: false,
    revision: 0,
    change: { kind: 'replace', entries: [] },
  })
  const turnIds = new Set()
  const attachments = new Map()
  let nextCursor
  let pending

  async function load(cursor) {
    state.update(current => {
      current.loadingOlder = Boolean(cursor)
      current.openError = null
      if (!cursor) current.openState = 'loading'
    })
    try {
      const page = await readPage('turns', { threadId: thread.id, ...(cursor ? { cursor } : {}) }, controller.signal)
      const previous = events.getSnapshot()
      const oldest = previous.entries[0]?.event
      const bounds = oldest && {
        beforeSeq: oldest.seq,
        beforeTurn: previous.entries.find(entry => entry.event.type === 'turn/start')?.event.data.turn,
      }
      const turns = mergePages([], page.data.toReversed()).filter(turn => !turnIds.has(turn.id))
      const pageAttachments = await readInlineCodexAttachments(turns, controller.signal)
      controller.signal.throwIfAborted()
      const entries = projectCodexTurns(turns, {
        ...bounds,
        provider: thread.modelProvider,
        createdAt: thread.createdAt,
        attachments: pageAttachments,
      })
      for (const turn of turns) turnIds.add(turn.id)
      for (const [id, entry] of pageAttachments) attachments.set(id, entry)
      nextCursor = page.nextCursor
      const hasMore = Boolean(nextCursor)
      events.set({
        entries: cursor ? [...entries, ...previous.entries] : entries,
        hasMore,
        revision: previous.revision + 1,
        change: { kind: cursor ? 'prepend' : 'replace', entries },
      })
      state.update(current => {
        current.hasMore = hasMore
        current.openState = 'open'
      })
    } catch (error) {
      if (!controller.signal.aborted) state.update(current => {
        current.openError = remoteFailure(error.message)
        current.openState = 'error'
      })
    } finally {
      if (!controller.signal.aborted) state.update(current => {
        current.loadingOlder = false
      })
    }
  }

  function request(cursor) {
    pending ??= load(cursor).finally(() => { pending = undefined })
    return pending
  }

  function loadOlder() {
    if (pending) return pending
    if (nextCursor || state.getSnapshot().openState === 'error') return request(nextCursor)
    return Promise.resolve()
  }

  async function loadThrough(seq) {
    while (!controller.signal.aborted && nextCursor && events.getSnapshot().entries[0]?.event.seq > seq) {
      const cursor = nextCursor
      await loadOlder()
      if (cursor === nextCursor) return
    }
  }

  const ready = request()
  return {
    events,
    ready,
    session: {
      getSnapshot: state.getSnapshot,
      subscribe: state.subscribe,
      loadOlder,
      loadThrough,
      async readAttachment(id) {
        const value = attachments.get(id)
        return value
          ? { ok: true, value }
          : { ok: false, error: remoteFailure('此附件无法从 Codex 历史接口读取。') }
      },
    },
  }
}
