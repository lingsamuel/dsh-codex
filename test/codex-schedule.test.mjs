import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScheduleDelivery } from '../src/host/schedule-delivery.mjs'

const signal = new AbortController().signal
const threadId = 'aa0b1c2d-1234-7abc-8def-010203040506'
const pending = { messageId: 'scheduled-occurrence', scheduledAt: '2026-11-24T09:00:00.000Z' }

function fixture({ cold = false, archived = false, blank = false, queue = [], turns = [], uncertain = false } = {}) {
  const calls = []
  let stored
  let status = cold ? 'notLoaded' : 'idle'
  function submit(id, work) {
    assert.equal(id, threadId)
    return work()
  }
  async function connect(_signal, run) {
    return run(async (method, params) => {
      calls.push(method)
      switch (method) {
        case 'thread/read': return { thread: { id: threadId, status: { type: status }, archived, historyMode: 'paginated',
          ...(!blank && { preview: 'Saved conversation' }) } }
        case 'thread/resume':
          status = 'idle'
          return { thread: { id: threadId, status: { type: status } } }
        case 'thread/list': return { data: archived ? [{ id: threadId }] : [], nextCursor: null }
        case 'thread/queue/list': return { data: queue, nextCursor: null }
        case 'thread/queue/add': {
          assert.deepEqual(stored, pending)
          assert.equal(params.clientUserMessageId, pending.messageId)
          const item = { id: 'queued', clientUserMessageId: params.clientUserMessageId }
          queue.push(item)
          if (uncertain) throw new Error('connection dropped')
          return { queuedSubmission: item }
        }
        case 'thread/queue/start':
          status = 'active'
          return { turn: { id: 'activity' } }
        case 'thread/turns/list': return { data: turns, nextCursor: null }
        default: throw new Error(`Unexpected request ${method}`)
      }
    })
  }
  return {
    calls,
    save: value => { stored = value },
    delivery: createScheduleDelivery(submit, signal, connect),
  }
}

test('到期投递先保存标识，恢复冷会话后只接纳一条原生队列消息', async () => {
  const { calls, save, delivery } = fixture({ cold: true })
  await delivery.validate(threadId)
  assert.equal(calls.includes('thread/resume'), false)
  const deliveredAt = await delivery.send(threadId, 'Follow up', pending, false, save)
  assert.ok(Number.isFinite(Date.parse(deliveredAt)))
  assert.ok(calls.indexOf('thread/resume') < calls.indexOf('thread/queue/add'))
  assert.ok(calls.includes('thread/queue/start'))
})

test('丢失原生回执后使用同一个标识读回，避免重复入队', async () => {
  const { calls, save, delivery } = fixture({ uncertain: true })
  await assert.rejects(delivery.send(threadId, 'Follow up', pending, false, save), /connection dropped/)
  assert.ok(await delivery.send(threadId, 'Follow up', pending, true, save))
  assert.equal(calls.filter(method => method === 'thread/queue/add').length, 1)
})

test('保存标识时已撤销请求，则清除尚未出站的投递', async () => {
  const { calls, save, delivery } = fixture()
  const owner = new AbortController()
  const saved = []
  await assert.rejects(delivery.send(threadId, 'Follow up', pending, false, value => {
    saved.push(value)
    save(value)
    owner.abort()
  }, owner.signal), { name: 'AbortError' })
  assert.deepEqual(saved, [pending, undefined])
  assert.equal(calls.includes('thread/queue/add'), false)
})

test('恢复时在历史里找到已完成的消息，无需提交或启用队列', async () => {
  const { calls, save, delivery } = fixture({ turns: [
    { id: 'complete', status: 'completed', items: [{ type: 'userMessage', clientId: pending.messageId }] },
  ] })
  assert.ok(await delivery.send(threadId, 'Follow up', pending, true, save))
  assert.equal(calls.includes('thread/queue/add'), false)
  assert.equal(calls.includes('thread/queue/start'), false)
})

test('归档会话不能启用计划或接收消息', async () => {
  const { calls, save, delivery } = fixture({ archived: true })
  await assert.rejects(delivery.validate(threadId), /无法/)
  await assert.rejects(delivery.send(threadId, 'Follow up', pending, false, save), /无法/)
  assert.equal(calls.includes('thread/resume'), false)
  assert.equal(calls.includes('thread/queue/add'), false)
})

test('Host 拒绝绕过界面选择还未保存的原生空白草稿', async () => {
  const { calls, delivery } = fixture({ blank: true })
  await assert.rejects(delivery.validate(threadId), /空白草稿/)
  assert.deepEqual(calls, ['thread/read'])
})
