import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveTranscript } from '../src/client/native-chat/live.js'

const user = { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'question' }] }
const command = { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'pwd', cwd: '/work', startedAtMs: 123_004 }

test('keeps native item position while publishing only the turn touched by an upsert', () => {
  const history = createLiveTranscript()
  const { turn: old } = history.reconcile({ id: 'old', status: 'completed', items: [user] })
  history.reconcile({ id: 'new', status: 'inProgress', startedAt: 123, items: [user, command] })
  const { turn: next, firstChanged, changes } = history.reconcile({ id: 'new' }, [{ ...command, aggregatedOutput: '/work\n' }, { id: 'assistant', type: 'agentMessage', text: 'end' }])
  assert.equal(firstChanged, 1)
  assert.deepEqual(changes, [{ previous: command, item: next.items[1] }, { previous: undefined, item: next.items[2] }])
  assert.deepEqual(next.items.map(item => item.id), ['user', 'command', 'assistant'])
  assert.equal(next.items[1].aggregatedOutput, '/work\n')
  assert.equal(next.items[1].startedAtMs, 123_004)
  assert.equal(next.startedAt, 123)
  assert.strictEqual(next.items[0], user)
  assert.strictEqual(history.getTurn('old'), old)
  assert.strictEqual(history.reconcile(JSON.parse(JSON.stringify(next))), undefined)
})

test('keeps settled timestamps, visible reasoning only, and terminal status across stale observations', () => {
  const history = createLiveTranscript()
  const reasoning = { id: 'reason', type: 'reasoning', summary: ['visible'], content: ['hidden'] }
  history.reconcile({ id: 'turn', startedAt: 123, status: 'inProgress', items: [user, command, reasoning] })
  const { turn: completed } = history.reconcile({ id: 'turn', startedAt: null, completedAt: 125, status: 'completed' }, [
    { ...command, status: 'completed', completedAtMs: 125_002, exitCode: 0 },
  ])
  assert.equal(completed.startedAt, 123)
  assert.equal(completed.completedAt, 125)
  assert.equal(completed.items[1].completedAtMs, 125_002)
  assert.deepEqual(completed.items[2], { id: 'reason', type: 'reasoning', summary: ['visible'] })
  assert.strictEqual(history.reconcile({ id: 'turn', status: 'inProgress' }, [command]), undefined)
  const older = { ...command, status: 'completed', completedAtMs: 125_001, exitCode: 1 }
  assert.strictEqual(history.reconcile({ id: 'turn' }, [older]), undefined)
  assert.strictEqual(history.getTurn('turn'), completed)
})
