import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHistoryTail } from '../src/host/live-history.mjs'

test('分页历史跟随只读取尾部增量，同一轮次结束时不重发旧条目', async () => {
  const completed = { id: 'old-item', type: 'agentMessage', text: '旧输出', completedAtMs: 2 }
  const fresh = { id: 'new-item', type: 'agentMessage', text: '新输出', completedAtMs: 3 }
  const earlier = { id: 'older', status: 'completed', items: [{ id: 'previous' }] }
  const active = { id: 'active', status: 'inProgress', items: [completed] }
  let head = { id: 'active', status: 'inProgress', items: [] }
  const requests = []
  const request = async (method, params) => {
    requests.push({ method, params })
    if (method === 'thread/turns/list') return { data: [head], backwardsCursor: 'head' }
    assert.equal(method, 'thread/items/list')
    return { data: [{ turnId: 'active', item: fresh, completedAtMs: 3 }] }
  }
  const tail = createHistoryTail(request, { id: 'thread', historyMode: 'paginated' }, {
    data: [active, earlier],
    backwardsCursor: 'head',
  })
  const first = await tail.readChanges()
  assert.equal(requests[0].params.itemsView, 'notLoaded')
  assert.deepEqual(requests[1].params.cursor, { type: 'item', itemId: 'old-item' })
  assert.equal(first.length, 1)
  assert.equal(first[0].turn.id, 'active')
  assert.deepEqual(first[0].items.map(item => item.id), ['new-item'])

  head = { ...head, status: 'completed' }
  const second = await tail.readChanges()
  assert.equal(second[0].turn.status, 'completed')
  assert.deepEqual(second[0].items, [])
  assert.deepEqual(await tail.readChanges(), [])
})

test('原生历史头部回退时重新同步，不把已撤回轮次留在增量通道', async () => {
  const previous = { id: 'previous', status: 'completed', items: [] }
  const request = async () => ({ data: [previous], backwardsCursor: 'previous-anchor' })
  const tail = createHistoryTail(request, { id: 'thread', historyMode: 'paginated' }, {
    data: [{ id: 'removed', status: 'completed', items: [] }, previous],
    backwardsCursor: 'removed-anchor',
  })
  assert.equal(await tail.readChanges(), null)
})
