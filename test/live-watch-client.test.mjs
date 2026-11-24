import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { openLiveWatch } from '../src/client/live-watch.js'

const encoder = new TextEncoder()

function watch(t, handlers) {
  const original = { document: globalThis.document, fetch: globalThis.fetch }
  const requests = []
  globalThis.document = { baseURI: 'http://127.0.0.1:3190/' }
  globalThis.fetch = async (input, options) => {
    const { signal } = options
    return new Response(new ReadableStream({
      start(body) {
        signal.addEventListener('abort', () => body.error(signal.reason), { once: true })
        requests.push({
          url: new URL(input), options,
          write: bytes => body.enqueue(bytes),
          send: text => body.enqueue(encoder.encode(text)),
          end: () => body.close(),
        })
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lifetime = new AbortController()
  t.after(async () => {
    lifetime.abort()
    await nextTurn()
    Object.assign(globalThis, original)
  })
  openLiveWatch('thread', handlers, lifetime.signal)
  return { requests, lifetime, advance: async ms => { t.mock.timers.tick(ms); await nextTurn() } }
}

test('慢投影期间不处理后续帧或检查点，重连使用已应用游标', async t => {
  const gate = Promise.withResolvers()
  const applied = []
  const modes = []
  const { requests, advance } = watch(t, {
    itemCursor: 'previous',
    async receive(frame) {
      applied.push(frame.text)
      if (frame.text === '正文') await gate.promise
    },
    checkpoint: cursor => applied.push(cursor),
    changeMode: mode => modes.push(mode),
  })
  assert.equal(requests.length, 1)
  const [first] = requests
  assert.equal(first.options.cache, 'no-store')
  assert.equal(first.url.searchParams.get('itemCursor'), 'previous')
  const prefix = 'data: {"text":"'
  const bytes = encoder.encode(prefix + '正文"}\n\n')
  first.write(bytes.subarray(0, prefix.length + 1))
  first.write(bytes.subarray(prefix.length + 1))
  first.send('data: {"text":"second"}\n\nid: applied\nevent: history-checkpoint\ndata: {}\n\n')
  await nextTurn()
  await advance(60_000)
  assert.deepEqual(applied, ['正文'])
  assert.deepEqual(modes, ['connecting'])
  assert.equal(requests.length, 1)

  gate.resolve()
  first.end()
  await nextTurn()
  assert.deepEqual(applied, ['正文', 'second', 'applied'])
  assert.deepEqual(modes, ['connecting', 'disconnected'])
  await advance(3_000)
  assert.equal(requests[1].url.searchParams.get('itemCursor'), 'applied')
})

test('归档切换后立即从已应用的游标重连，后续意外断开仍报告中断', async t => {
  const applied = []
  const modes = []
  const { requests, advance } = watch(t, {
    receive: frame => applied.push(frame.notification.method),
    checkpoint: cursor => applied.push(cursor),
    changeMode: mode => modes.push(mode),
  })
  const [first] = requests
  first.send('id: saved\nevent: history-checkpoint\ndata: {}\n\n')
  first.send('data: {"type":"notification","notification":{"method":"thread/unarchived"}}\n\n')
  first.send('event: watch-restart\ndata: {}\n\n')
  first.end()
  await nextTurn()

  assert.deepEqual(applied, ['saved', 'thread/unarchived'])
  assert.deepEqual(modes, ['connecting', 'connecting'])
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url.searchParams.get('itemCursor'), 'saved')

  requests[1].end()
  await nextTurn()
  assert.deepEqual(modes, ['connecting', 'connecting', 'disconnected'])
  assert.equal(requests.length, 2)
  await advance(3_000)
  assert.equal(requests.length, 3)
})

test('投影失败后从最后成功的检查点继续', async t => {
  const applied = []
  const { requests, advance } = watch(t, {
    itemCursor: 'previous',
    async receive({ text }) {
      if (text === 'failure') return false
      applied.push(text)
    },
    checkpoint: cursor => applied.push(cursor),
  })
  assert.equal(requests.length, 1)
  const [first] = requests
  first.send('data: {"text":"first"}\n\nid: valid\nevent: history-checkpoint\ndata: {}\n\n')
  first.send('data: {"text":"failure"}\n\nid: invalid\nevent: history-checkpoint\ndata: {}\n\n')
  await nextTurn()
  assert.deepEqual(applied, ['first', 'valid'])
  assert.equal(first.options.signal.aborted, true)
  await advance(3_000)
  assert.equal(requests[1].url.searchParams.get('itemCursor'), 'valid')
})

test('连接初始化失败时关闭流并保留检查点', async t => {
  const applied = []
  const { requests, advance } = watch(t, {
    itemCursor: 'previous',
    changeMode: mode => mode === 'connecting' ? false : undefined,
    receive: frame => applied.push(frame),
    checkpoint: cursor => applied.push(cursor),
  })
  const [first] = requests
  first.send('data: {"text":"ignored"}\n\nid: skipped\nevent: history-checkpoint\ndata: {}\n\n')
  await nextTurn()
  assert.deepEqual(applied, [])
  assert.equal(first.options.signal.aborted, true)
  await advance(3_000)
  assert.equal(requests[1].url.searchParams.get('itemCursor'), 'previous')
})

test('投影期间释放观察会取消 HTTP 请求，并丢弃后续检查点', async t => {
  const gate = Promise.withResolvers()
  const received = Promise.withResolvers()
  const checkpoints = []
  const { requests, lifetime, advance } = watch(t, {
    async receive(_frame, connection) {
      received.resolve(connection)
      await gate.promise
    },
    checkpoint: cursor => checkpoints.push(cursor),
  })
  t.after(() => gate.resolve())
  const [first] = requests
  first.send('data: {"text":"first"}\n\nid: stale\nevent: history-checkpoint\ndata: {}\n\n')
  const connection = await received.promise
  lifetime.abort()
  assert.equal(first.options.signal.aborted, true)
  assert.equal(connection.aborted, true)
  gate.resolve()
  await nextTurn()
  await advance(60_000)
  assert.deepEqual(checkpoints, [])
  assert.equal(requests.length, 1)
})

test('心跳与大帧的部分数据延长网络空闲时间，停止观察时取消请求和重试', async t => {
  const frames = []
  const { requests, lifetime, advance } = watch(t, { receive: frame => frames.push(frame) })
  assert.equal(requests.length, 1)
  const [first] = requests
  await nextTurn()
  await advance(30_000)
  first.send('event: heartbeat\ndata: {}\n\n')
  await nextTurn()
  await advance(30_000)
  first.send('data: {"text":"partial')
  await nextTurn()
  await advance(35_000)
  assert.deepEqual(frames, [])
  assert.equal(first.options.signal.aborted, false)
  await advance(10_000)
  assert.equal(first.options.signal.aborted, true)
  await advance(3_000)
  assert.equal(requests.length, 2)
  lifetime.abort()
  assert.equal(requests[1].options.signal.aborted, true)
  await advance(60_000)
  assert.equal(requests.length, 2)
})
