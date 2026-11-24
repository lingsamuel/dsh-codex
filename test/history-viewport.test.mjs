import assert from 'node:assert/strict'
import test from 'node:test'
import { preserveHistoryPrepend } from '../src/client/native-dsh/history-viewport.js'

function viewport({ following = false, nested = false } = {}) {
  const bounds = { top: 30, bottom: 430, left: 0, right: 500 }
  const scroller = { scrollTop: 100, getBoundingClientRect: () => bounds }
  let visible
  const scope = { closest: () => scroller, querySelector: () => column }
  const embedded = { dataset: { chatAnchorKey: 'embedded-turn' }, getBoundingClientRect: () => ({ top: 30 }),
    closest(selector) { return selector === '[data-chat-anchor-key]' ? this : selector === '[data-codex-history-view]' ? embedded : null } }
  const column = {
    isConnected: true,
    closest: selector => selector === '[data-codex-history-view]' ? scope : following ? { closest: () => scope } : null,
    contains: node => node === visible || node === embedded,
    getBoundingClientRect: () => bounds,
    querySelector: () => visible,
    ownerDocument: { elementsFromPoint: () => nested ? [embedded, visible] : [visible], documentElement: { clientWidth: 500, clientHeight: 500 },
      defaultView: { CSS: { escape: value => value } } },
  }
  function row(key, position) {
    visible = {
      dataset: { chatAnchorKey: key }, position,
      closest(selector) { return selector === '[data-chat-anchor-key]' ? this : selector === '[data-codex-history-view]' ? scope : null },
      getBoundingClientRect() { return { top: this.position - scroller.scrollTop } },
    }
    return visible
  }
  return { scope, scroller, row }
}

test('each history prepend keeps the row currently being read in place', () => {
  const { scope, scroller, row } = viewport()
  const first = row('current-turn', 123)
  preserveHistoryPrepend(scope, () => { first.position += 510 })
  assert.equal(first.getBoundingClientRect().top, 23)

  scroller.scrollTop -= 175
  const next = row('another-turn', 463)
  preserveHistoryPrepend(scope, () => { next.position += 240 })
  assert.equal(next.getBoundingClientRect().top, 28)
})

test('a history prepend does not repeat browser scroll anchoring', () => {
  const { scope, scroller, row } = viewport()
  const current = row('current-turn', 123)
  preserveHistoryPrepend(scope, () => {
    current.position += 200
    scroller.scrollTop += 200
  })
  assert.equal(scroller.scrollTop, 300)
})

test('a history prepend can retain an anchor that remounts under another group', () => {
  const { scope, scroller, row } = viewport()
  row('current-turn', 123)
  preserveHistoryPrepend(scope, () => { row('current-turn', 323) })
  assert.equal(scroller.scrollTop, 300)
})

test('the native viewport keeps ownership when it follows the tail', () => {
  const { scope, scroller, row } = viewport({ following: true })
  const current = row('current-turn', 123)
  let published = 0
  preserveHistoryPrepend(scope, () => { published++; current.position += 200 })
  assert.equal(published, 1)
  assert.equal(scroller.scrollTop, 100)
})

test('manual history leaves a short tail-followed conversation at the current row', () => {
  const { scope, scroller, row } = viewport({ following: true })
  const current = row('current-turn', 123)
  preserveHistoryPrepend(scope, () => { current.position += 200 }, { manual: true })
  assert.equal(scroller.scrollTop, 300)
})

test('a history prepend ignores anchors owned by an embedded conversation', () => {
  const { scope, scroller, row } = viewport({ nested: true })
  const current = row('current-turn', 123)
  preserveHistoryPrepend(scope, () => { current.position += 200 })
  assert.equal(scroller.scrollTop, 300)
})
