import assert from 'node:assert/strict'
import test from 'node:test'
import { describeLiveStatus, publishPendingStatus } from '../src/client/native-dsh/live-status.js'

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
  for (const result of ['failed', 'interrupted']) {
    assert.deepEqual(describeLiveStatus({
      mode: 'history', status: { type: 'notLoaded' }, lastTurnStatus: result,
    }), { mode: 'history', activity: result })
  }
  assert.deepEqual(describeLiveStatus({
    mode: 'live', status: { type: 'idle' }, lastTurnStatus: 'completed',
  }), { mode: undefined, activity: undefined })
  assert.deepEqual(describeLiveStatus({
    mode: 'live', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, lastTurnStatus: 'inProgress',
  }), { mode: undefined, activity: undefined })
})
