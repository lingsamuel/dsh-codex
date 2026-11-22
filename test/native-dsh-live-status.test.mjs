import assert from 'node:assert/strict'
import test from 'node:test'
import { describeLiveStatus } from '../src/client/native-dsh/live-status.js'

test('优先显示 Codex 等待审批或回复的状态', () => {
  assert.deepEqual(describeLiveStatus({
    mode: 'live',
    status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
    lastTurnStatus: 'inProgress',
  }), { mode: 'live', activity: 'waitingForApprovalAndAnswer' })
  assert.equal(describeLiveStatus({
    mode: 'live',
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  }).activity, 'waitingForApproval')
  assert.equal(describeLiveStatus({
    mode: 'live',
    status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
  }).activity, 'waitingForAnswer')
  assert.equal(describeLiveStatus({
    mode: 'live',
    status: { type: 'active', activeFlags: [] },
  }).activity, 'running')
})

test('保留最后一轮的结果，连接中或断开时不显示陈旧的运行和等待状态', () => {
  for (const mode of ['connecting', 'history', 'disconnected']) {
    assert.deepEqual(describeLiveStatus({
      mode,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      lastTurnStatus: 'inProgress',
    }), { mode, activity: undefined })
  }
  for (const result of ['completed', 'failed', 'interrupted']) {
    assert.deepEqual(describeLiveStatus({
      mode: 'history', status: { type: 'notLoaded' }, lastTurnStatus: result,
    }), { mode: 'history', activity: result })
  }
  assert.equal(describeLiveStatus({
    mode: 'live', status: { type: 'idle' }, lastTurnStatus: 'inProgress',
  }).activity, 'idle')
})
