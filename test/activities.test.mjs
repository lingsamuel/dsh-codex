import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupVisibleItems } from '../src/client/activities.js'

test('命令折叠以消息和其他活动为边界，保留原生事件顺序', () => {
  const items = [
    { type: 'commandExecution', id: 'read' },
    { type: 'commandExecution', id: 'edit' },
    { type: 'agentMessage', id: 'commentary', text: '继续检查。' },
    { type: 'commandExecution', id: 'test' },
    { type: 'userMessage', id: 'steer' },
    { type: 'commandExecution', id: 'check' },
  ]
  assert.deepEqual(groupVisibleItems(items), [
    [items[0], items[1]], [items[2]], [items[3]], [items[4]], [items[5]],
  ])
})

test('不可见推理和空文本不占行或打断命令分组，可见正文保持原样', () => {
  const read = { type: 'commandExecution', id: 'read' }
  const check = { type: 'commandExecution', id: 'check' }
  const summary = { type: 'reasoning', id: 'visible', summary: ['核对日志'] }
  const answer = { type: 'agentMessage', id: 'answer', text: '结论\n\n```\n  line\n\n\n  end\n```' }

  assert.deepEqual(groupVisibleItems([
    read,
    { type: 'reasoning', id: 'encrypted', summary: [] },
    { type: 'reasoning', id: 'whitespace', summary: ['  ', '\n'] },
    { type: 'agentMessage', id: 'blank', text: '  \n' },
    { type: 'plan', id: 'empty', text: '' },
    check,
    summary,
    answer,
  ]), [[read, check], [summary], [answer]])
})
