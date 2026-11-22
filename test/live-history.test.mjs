import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexRpcError } from '../src/host/app-server.mjs'
import { createHistoryTail } from '../src/host/live-history.mjs'

async function readChanges(tail) {
  const updates = []
  return await tail.readChanges(update => updates.push(update)) ? updates : null
}

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
  const first = await readChanges(tail)
  assert.equal(requests[0].params.itemsView, 'notLoaded')
  assert.deepEqual(requests.find(({ params }) => params.turnId === 'active').params.cursor, { type: 'item', itemId: 'old-item' })
  assert.equal(first.length, 1)
  assert.equal(first[0].turn.id, 'active')
  assert.deepEqual(first[0].items.map(item => item.id), ['new-item'])

  head = { ...head, status: 'completed' }
  const second = await readChanges(tail)
  assert.equal(second[0].turn.status, 'completed')
  assert.deepEqual(second[0].items, [])
  assert.deepEqual(await readChanges(tail), [])
})

test('原生历史头部回退时重新同步，不把已撤回轮次留在增量通道', async () => {
  const previous = { id: 'previous', status: 'completed', items: [] }
  const request = async () => ({ data: [previous], backwardsCursor: 'previous-anchor' })
  const tail = createHistoryTail(request, { id: 'thread', historyMode: 'paginated' }, {
    data: [{ id: 'removed', status: 'completed', items: [] }, previous],
    backwardsCursor: 'removed-anchor',
  })
  assert.equal(await readChanges(tail), null)
})

test('App Server 拒绝旧轮次游标时以快照替换历史窗口', async () => {
  const before = { id: 'before', status: 'completed', items: [] }
  const after = { id: 'after', status: 'completed', items: [] }
  const request = async (method, { cursor, sortDirection }) => {
    if (method === 'thread/items/list') return { data: [], backwardsCursor: 'current-item' }
    if (sortDirection === 'desc') return { data: [after] }
    assert.equal(cursor, 'invalid-turn')
    throw new CodexRpcError({ code: -32600, message: 'invalid cursor' })
  }
  const tail = createHistoryTail(request, { id: 'thread', historyMode: 'paginated' },
    { data: [before], backwardsCursor: 'invalid-turn' }, 'previous-item')
  assert.equal(await readChanges(tail), null)
  assert.equal(tail.itemCursor(), 'previous-item')
})

test('较早轮次结束后保存的子智能体活动仍会推送到原轮次', async () => {
  const started = { id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/review' }
  const completed = { ...started, id: 'done', kind: 'completed' }
  const latest = { id: 'latest', status: 'completed', items: [{ id: 'latest-reply' }] }
  const earlier = { id: 'earlier', status: 'completed', items: [started] }
  let saved = false
  const request = async (method, { turnId, cursor, sortDirection }) => {
    if (method === 'thread/turns/list') return { data: [{ ...latest, items: [] }] }
    const done = { turnId: earlier.id, item: completed, completedAtMs: 300 }
    if (!turnId && sortDirection === 'desc') return saved
      ? { data: [done], backwardsCursor: 'after-done' }
      : { data: [{ turnId: latest.id, item: latest.items[0] }], backwardsCursor: 'after-reply' }
    if (!turnId && cursor === 'after-reply' && saved) return { data: [done] }
    if (turnId === earlier.id && saved) return { data: [done] }
    return { data: [] }
  }
  const tail = createHistoryTail(request, { id: 'root', historyMode: 'paginated' }, { data: [latest, earlier] }, 'after-reply')
  assert.deepEqual(await readChanges(tail), [])
  saved = true
  const changes = await readChanges(tail)
  assert.deepEqual(changes.map(({ turn, items }) => [turn.id, turn.status, items.map(item => item.id)]), [
    ['earlier', 'completed', ['done']],
  ])
  assert.deepEqual(await readChanges(tail), [])
})

test('晚到条目逐页交付，并将读页期间写入的条目留给下一次检查', async () => {
  const latest = { id: 'latest', status: 'completed', items: [] }
  const late = id => ({ turnId: 'earlier', item: { id, type: 'agentMessage', text: id } })
  const first = late('first')
  const boundary = late('boundary')
  const concurrent = late('concurrent')
  let newest = boundary
  const requests = []
  const request = async (method, { cursor, sortDirection }) => {
    if (method === 'thread/turns/list') return { data: [latest] }
    if (sortDirection === 'desc') return { data: [newest], backwardsCursor: newest.item.id }
    requests.push(cursor)
    if (cursor === 'start') return { data: [first], nextCursor: 'page-two' }
    if (cursor === 'page-two') return { data: [boundary, concurrent], nextCursor: 'past-boundary' }
    if (cursor === 'boundary') return { data: [boundary, concurrent] }
    return { data: [] }
  }
  const tail = createHistoryTail(request, { id: 'thread', historyMode: 'paginated' }, { data: [latest] }, 'start')
  const gate = Promise.withResolvers()
  const consuming = Promise.withResolvers()
  const received = []
  const reading = tail.readChanges(async ({ items, onlyIfLoaded }) => {
    assert.equal(onlyIfLoaded, true)
    received.push(...items.map(item => item.id))
    if (items[0]?.id === 'first') {
      consuming.resolve()
      await gate.promise
    }
  })
  await consuming.promise
  assert.deepEqual(requests, ['start'])
  assert.equal(tail.itemCursor(), 'start')
  newest = concurrent
  gate.resolve()
  assert.equal(await reading, true)
  assert.deepEqual(requests, ['start', 'page-two'])
  assert.deepEqual(received, ['first', 'boundary'])
  assert.equal(tail.itemCursor(), 'boundary')
  // 反向游标正向续读时可包含原锚点，浏览器按原生条目 ID 合并。
  assert.deepEqual((await readChanges(tail)).flatMap(({ items }) => items.map(item => item.id)), ['boundary', 'concurrent'])
  assert.equal(tail.itemCursor(), 'concurrent')
})

test('增量未交付完或遇到重复游标时保留原检查点', async () => {
  const head = { id: 'head', status: 'inProgress', items: [] }
  const items = cursor => [{ turnId: head.id, item: { id: cursor ?? 'first', type: 'agentMessage' } }]
  const cursors = []
  const request = async (method, { sortDirection, turnId, cursor }) => {
    if (method === 'thread/turns/list') return { data: [head] }
    if (!turnId && sortDirection === 'desc') return { data: items('latest'), backwardsCursor: 'next' }
    cursors.push(cursor)
    return { data: items(cursor), nextCursor: 'repeated' }
  }
  const follow = () => createHistoryTail(request, { id: 'thread', historyMode: 'paginated' }, { data: [head] }, 'old')
  const cancelled = follow()
  assert.equal(await cancelled.readChanges(() => false), false)
  assert.deepEqual(cursors, [undefined])
  assert.equal(cancelled.itemCursor(), 'old')

  const resumed = follow()
  const received = []
  await assert.rejects(resumed.readChanges(({ items }) => received.push(...items)), /重复的分页游标/)
  assert.deepEqual(cursors, [undefined, undefined, 'repeated'])
  assert.deepEqual(received.map(item => item.id), ['first'])
  assert.equal(resumed.itemCursor(), 'old')
})
