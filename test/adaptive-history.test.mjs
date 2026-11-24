import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as history from '../src/host/history-window.mjs'

const thread = { id: 'thread', historyMode: 'paginated' }
const settings = { firstItems: 6, firstMiB: 1, openTurns: 15 }

function fixture(sizes) {
  const payload = (id, n) => Array.from({ length: n }, (_, index) => ({
    id: `${id}-${index}`, type: index ? 'commandExecution' : 'userMessage',
  }))
  const items = sizes.map((size, index) => payload(`turn-${index}`, size))
  const reads = []
  const request = async (method, params) => {
    const { limit, itemsView, cursor, turnId } = params
    reads.push({ method, ...params })
    if (method === 'thread/turns/list') {
      const offset = cursor ? Number(cursor.slice(1)) : 0
      const end = Math.min(offset + limit, items.length)
      return { data: items.slice(offset, end).map((rows, index) => ({
        id: `turn-${offset + index}`, status: 'completed', itemsView,
        items: itemsView === 'full' ? rows : rows.slice(0, 1),
      })), nextCursor: end < items.length ? `p${end}` : null, backwardsCursor: 'head' }
    }
    assert.equal(method, 'thread/items/list')
    const rows = items[Number(turnId.slice(5))]
    return { data: rows.slice(0, limit).map(item => ({ item })), nextCursor: rows.length > limit ? 'remaining' : null }
  }
  return { request, reads }
}

test('首屏保留最近三轮并用有界摘要替代超预算详情，继续从第三轮之后的原生游标读取', async () => {
  const { request, reads } = fixture([2, 13, 2, 8])
  const page = await history.readOpeningHistory(request, thread, undefined, settings)
  assert.deepEqual(page.data.map(({ id, items, itemsView }) => [id, items.length, itemsView]), [
    ['turn-0', 2, 'full'], ['turn-1', 1, 'summary'], ['turn-2', 2, 'full'],
  ])
  assert.equal(page.nextCursor, 'p3')
  assert.equal(page.backwardsCursor, 'head')
  assert.ok(reads.every(read => read.turnId !== 'turn-1' || read.limit < 13))
})

test('轻量首屏完整加载配置允许的十五轮，并保留更早的轮次', async () => {
  const { request } = fixture(Array(16).fill(1))
  const page = await history.readOpeningHistory(request, thread, undefined, { ...settings, firstItems: 1000 })
  assert.deepEqual(page.data.map(({ items }) => items.length), Array(15).fill(1))
  assert.equal(page.nextCursor, 'p15')
})

test('旧格式先发送有界摘要，展开时用原生游标取回完整轮次', async () => {
  const { request } = fixture([2, 13, 2, 8])
  const page = await history.readOpeningHistory(request, { ...thread, historyMode: 'legacy' }, undefined, settings)
  assert.deepEqual(page.data.map(({ itemsView }) => itemsView), ['full', 'summary', 'full'])
  assert.equal(page.nextCursor, 'p3')
  const details = await history.readLegacyTurnDetails(request, thread.id, 'turn-1')
  assert.equal(details.data.length, 13)
  assert.equal(details.data[0].id, 'turn-1-0')
})
