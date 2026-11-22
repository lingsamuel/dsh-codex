import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupCommands } from '../src/client/activities.js'

test('命令折叠以消息和其他活动为边界，保留原生事件顺序', () => {
  const items = [
    { type: 'commandExecution', id: 'read' },
    { type: 'commandExecution', id: 'edit' },
    { type: 'agentMessage', id: 'commentary' },
    { type: 'commandExecution', id: 'test' },
    { type: 'userMessage', id: 'steer' },
    { type: 'commandExecution', id: 'check' },
  ]
  assert.deepEqual(groupCommands(items), [
    [items[0], items[1]], [items[2]], [items[3]], [items[4]], [items[5]],
  ])
})
