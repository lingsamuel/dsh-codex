import assert from 'node:assert/strict'
import test from 'node:test'
import { describeLiveStatus, installUnreadStatus, publishPendingStatus } from '../src/client/native-dsh/live-status.js'

test('DSH 绿点以 Codex 未读为准，并保留原生运行和等待标记', () => {
  const waiting = { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }
  const native = new Map([['locallyDone', { running: false, completionUnread: true }], ['waiting', waiting]])
  const status = { getSnapshot: () => native, subscribe: () => () => {} }
  let unreadIds = ['waiting', 'fromCodex']
  let changed
  const release = installUnreadStatus(status, {
    getSnapshot: () => ({ unreadIds }),
    subscribe(listener) { changed = listener; return () => { changed = undefined } },
  })
  const view = status.getSnapshot()
  assert.equal(view.get('locallyDone').completionUnread, false)
  assert.deepEqual(view.get('waiting'), { ...waiting, completionUnread: true })
  assert.equal(view.get('fromCodex').completionUnread, true)
  assert.strictEqual(view, status.getSnapshot())
  let updates = 0
  const unsubscribe = status.subscribe(() => updates++)
  unreadIds = []
  changed()
  assert.equal(updates, 1)
  assert.equal(status.getSnapshot().has('fromCodex'), false)
  assert.equal(status.getSnapshot().get('waiting').completionUnread, false)
  unsubscribe()
  assert.equal(changed, undefined)
  release()
  assert.strictEqual(native, status.getSnapshot())
})

test('向 DSH 发布等待状态，后续更新和移除会清理原提醒', () => {
  let threads = []
  let changed
  const catalog = {
    getSnapshot: () => ({ threads }),
    subscribe(listener) { changed = listener; return () => { changed = undefined } },
  }
  const pending = new Map()
  const dispose = publishPendingStatus(catalog, interaction => {
    assert.ok(!pending.has(interaction.sessionId))
    pending.set(interaction.sessionId, interaction)
    return () => pending.delete(interaction.sessionId)
  })
  const waiting = (id, ...activeFlags) => ({ id, status: { type: 'active', activeFlags } })
  threads = [waiting('main', 'waitingOnApproval', 'waitingOnUserInput'), waiting('background', 'waitingOnApproval')]
  changed()
  assert.equal(pending.get('main').kind, 'question')
  assert.equal(pending.get('background').kind, 'approval')
  const approval = pending.get('background')
  threads = [waiting('main'), waiting('background', 'waitingOnApproval')]
  changed()
  assert.equal(pending.has('main'), false)
  assert.equal(pending.get('background'), approval)
  threads = [waiting('background', 'waitingOnUserInput')]
  changed()
  assert.equal(pending.get('background').kind, 'question')
  assert.notEqual(pending.get('background').key, approval.key)
  threads = []
  changed()
  assert.equal(pending.size, 0)
  threads = [waiting('background', 'waitingOnApproval')]
  changed()
  dispose()
  assert.equal(pending.size, 0)
  assert.equal(changed, undefined)
})

test('标题栏保留连接提示与异常结果，常规状态由 DSH 侧栏显示', () => {
  for (const mode of ['connecting', 'history', 'disconnected']) {
    assert.deepEqual(describeLiveStatus({
      mode,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      lastTurnStatus: 'inProgress',
    }), { mode, activity: undefined })
  }
  assert.deepEqual(describeLiveStatus({
    mode: 'history', status: { type: 'notLoaded' }, lastTurnStatus: 'failed',
  }), { mode: 'history', activity: 'failed' })
  assert.deepEqual(describeLiveStatus({
    mode: 'history', status: { type: 'notLoaded' }, lastTurnStatus: 'interrupted',
  }), { mode: 'history', activity: undefined })
  for (const lastTurnStatus of ['completed', 'interrupted']) {
    assert.deepEqual(describeLiveStatus({
      mode: 'live', status: { type: 'idle' }, lastTurnStatus,
    }), { mode: undefined, activity: undefined })
  }
  assert.deepEqual(describeLiveStatus({
    mode: 'live', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, lastTurnStatus: 'inProgress',
  }), { mode: undefined, activity: undefined })
})
