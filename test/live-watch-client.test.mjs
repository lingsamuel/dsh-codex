import assert from 'node:assert/strict'
import test from 'node:test'
import { openLiveWatch } from '../src/client/live-watch.js'

test('收到心跳时保持连接，停更时重新建立会话观察', t => {
  const original = { document: globalThis.document, EventSource: globalThis.EventSource }
  const sources = []
  globalThis.document = { baseURI: 'http://127.0.0.1:3190/' }
  globalThis.EventSource = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url.href
      sources.push(this)
    }
    close() { this.closed = true }
  }
  t.after(() => Object.assign(globalThis, original))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lifetime = new AbortController()
  const modes = []
  const frames = []
  openLiveWatch('thread', { receive: frame => frames.push(frame), changeMode: mode => modes.push(mode) }, lifetime.signal)

  const [first] = sources
  first.onopen()
  t.mock.timers.tick(30_000)
  first.dispatchEvent(new Event('heartbeat'))
  t.mock.timers.tick(35_000)
  assert.equal(sources.length, 1)
  assert.deepEqual(frames, [])
  t.mock.timers.tick(15_000)
  assert.equal(first.closed, true)
  assert.equal(sources.length, 2)
  assert.equal(sources[1].url, first.url)

  sources[1].onopen()
  first.onmessage?.({ data: '{"type":"stale"}' })
  sources[1].onmessage({ data: '{"type":"snapshot"}' })
  assert.deepEqual(modes, ['connecting', 'disconnected', 'connecting'])
  assert.deepEqual(frames, [{ type: 'snapshot' }])
  lifetime.abort()
  assert.equal(sources[1].closed, true)
  t.mock.timers.tick(60_000)
  assert.equal(sources.length, 2)
})
