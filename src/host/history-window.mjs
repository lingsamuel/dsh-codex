import { DatabaseSync } from 'node:sqlite'
import { iterateCodexPages } from './app-server.mjs'
import { flattenHistoryItem, readThreadTurns } from './live-history.mjs'
import { historyIndexLocation } from './history-watch.mjs'

const minimumTurns = 3
const itemPageSize = 100
const detailItems = 500
const detailBytes = 512 * 1024

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

/** SQLite 只用于估算原生记录大小。完整条目和游标仍由 App Server 提供。 */
function estimateTurns(thread, sqliteHome, turns) {
  const { database, projectionId } = historyIndexLocation(thread, sqliteHome)
  if (!database || !projectionId) return new Map()
  try {
    using db = new DatabaseSync(database, { readOnly: true })
    // octet_length 可以读取 SQLite 记录头，避免逐条解析已投影的 JSON。
    const query = db.prepare(`SELECT count(*) AS items, coalesce(sum(octet_length(item_json)), 0) AS bytes
      FROM thread_items WHERE thread_id = ? AND turn_id = ?`)
    return new Map(turns.map(({ id }) => [id, query.get(projectionId, id)]))
  } catch {
    return new Map()
  }
}

function previewText(value) {
  return typeof value === 'string' && value.length > 512 ? `${value.slice(0, 512)}…` : value
}

function boundedSummary(turn, maxBytes) {
  if (jsonBytes(turn) <= maxBytes) return turn
  const items = (turn.items ?? []).filter(item => ['userMessage', 'agentMessage'].includes(item.type)).map(item => {
    const { id, type, startedAtMs, completedAtMs, phase } = item
    const identity = { id, type, startedAtMs, completedAtMs, phase, historyPreview: true }
    if (item.type === 'agentMessage') return { ...identity, text: previewText(item.text) }
    const text = item.content?.find(part => part.type === 'text')?.text
    return { ...identity, content: text === undefined ? [] : [{ type: 'text', text: previewText(text) }] }
  })
  return { ...turn, items }
}

function legacySummary(turn) {
  const items = turn.items ?? []
  return { ...turn, itemsView: 'summary', items: [items.find(item => item.type === 'userMessage'),
    items.findLast(item => item.type === 'agentMessage')].filter(Boolean) }
}

/** 按原生轮内游标读一页，供首屏挑选及按需详情使用。 */
export async function readHistoryItemPage(request, threadId, turnId, cursor, limit = itemPageSize) {
  const page = await request('thread/items/list', {
    threadId, turnId, limit, sortDirection: 'asc', ...(cursor != null && { cursor }),
  })
  return { data: page.data.map(flattenHistoryItem), nextCursor: page.nextCursor }
}

async function readFullTurn(request, threadId, turn, estimate, maxItems, maxBytes) {
  if (estimate?.items > maxItems || estimate?.bytes > maxBytes) return null
  if (turn.itemsView !== 'summary') {
    return (turn.items?.length ?? 0) <= maxItems && jsonBytes(turn) <= maxBytes ? turn : null
  }
  if (maxItems < 0 || maxBytes <= 0) return null
  const items = []
  let bytes = jsonBytes({ ...turn, items })
  const pages = iterateCodexPages(cursor => readHistoryItemPage(request, threadId, turn.id, cursor,
    Math.max(1, Math.min(itemPageSize, maxItems - items.length + 1))))
  for await (const page of pages) {
    for (const item of page.data) {
      bytes += jsonBytes(item) + 1
      if (items.length >= maxItems || bytes > maxBytes) return null
      items.push(item)
    }
    if (items.length >= maxItems && page.nextCursor) return null
  }
  return { ...turn, itemsView: 'full', items }
}

/** 首屏保留最近轮次的可读内容，正文和更早的游标按实际可交付量确定。 */
export async function readOpeningHistory(request, thread, sqliteHome, preferences) {
  const { id: threadId, historyMode } = thread
  const params = { threadId, limit: Math.min(preferences.openTurns, 100), sortDirection: 'desc' }
  const paginated = historyMode === 'paginated'
  const candidate = await readThreadTurns(request, { ...params, itemsView: paginated ? 'summary' : 'full' })
  // 不支持条目分页的活动线程仍需要完整运行时历史，供增量比较和交互投影使用。
  if (!paginated && candidate.data.some(turn => turn.status === 'inProgress')) return candidate
  const maxBytes = Math.floor(preferences.firstMiB * 1024 * 1024)
  const maxItems = preferences.firstItems
  const keep = Math.min(minimumTurns, candidate.data.length)
  const data = candidate.data.slice(0, keep).map(turn => boundedSummary(paginated ? turn : legacySummary(turn),
    Math.floor(maxBytes / minimumTurns)))
  let bytes = jsonBytes(data)
  let count = data.reduce((total, turn) => total + (turn.items?.length ?? 0), 0)
  const estimates = paginated ? estimateTurns(thread, sqliteHome, candidate.data) : new Map()
  for (const [index, turn] of candidate.data.entries()) {
    const summary = data[index]
    const summaryBytes = summary ? jsonBytes(summary) : 0
    const summaryCount = summary?.items?.length ?? 0
    const full = await readFullTurn(request, threadId, turn, estimates.get(turn.id),
      maxItems - count + summaryCount, maxBytes - bytes + summaryBytes - 1)
    if (!full) {
      if (index >= keep) break
      continue
    }
    data[index] = full
    bytes += jsonBytes(full) - summaryBytes + (summary ? 0 : 1)
    count += (full.items?.length ?? 0) - summaryCount
  }
  if (data.length === candidate.data.length) return { ...candidate, data }
  // 原生游标只能由相同长度的窗口返回。锚点变化时让调用方从新快照重读。
  const page = await readThreadTurns(request, { ...params, limit: data.length, itemsView: 'notLoaded' })
  if (page.data.length !== data.length || page.data.some((turn, index) => turn.id !== data[index].id)) {
    throw new Error('读取时 Codex 历史窗口发生变化。')
  }
  return { ...page, data }
}

/** 每次交付一轮。厚重轮次保留可读摘要，较早的轮次仍沿同一游标推进。 */
export async function readOlderHistoryTurn(request, thread, sqliteHome, cursor) {
  const paginated = thread.historyMode === 'paginated'
  const page = await readThreadTurns(request, {
    threadId: thread.id, cursor, limit: 1, sortDirection: 'desc', itemsView: paginated ? 'summary' : 'full',
  })
  if (!page.data.length) return page
  const [turn] = page.data
  const estimate = paginated ? estimateTurns(thread, sqliteHome, page.data).get(turn.id) : undefined
  const full = await readFullTurn(request, thread.id, turn, estimate, detailItems, detailBytes)
  return { ...page, data: [full ?? boundedSummary(paginated ? turn : legacySummary(turn), detailBytes)] }
}

/** 旧格式只能用原生轮次游标定位，再一次读出该轮完整的已保存条目。 */
export async function readLegacyTurnDetails(request, threadId, turnId) {
  const params = { threadId, sortDirection: 'desc' }
  let before
  const pages = iterateCodexPages(cursor => readThreadTurns(request,
    { ...params, cursor, limit: 100, itemsView: 'notLoaded' }))
  for await (const page of pages) {
    const index = page.data.findIndex(turn => turn.id === turnId)
    if (index !== -1) {
      const cursor = index ? (await readThreadTurns(request,
        { ...params, cursor: before, limit: index, itemsView: 'notLoaded' })).nextCursor : before
      const [turn] = (await readThreadTurns(request, { ...params, cursor, limit: 1, itemsView: 'full' })).data
      if (turn?.id === turnId) return { data: turn.items ?? [], nextCursor: null }
      break
    }
    before = page.nextCursor
  }
  throw new Error('原生历史中已找不到该轮次。')
}
