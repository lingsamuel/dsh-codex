import assert from 'node:assert/strict'
import test from 'node:test'
import { codexTurnChanges } from '../src/client/native-chat/turn-changes.js'

test('轮次改动按原生路径归组，保留同一文件的多次变更并排除拒绝项', () => {
  function edit(id, status, path, diff) {
    return { id, type: 'fileChange', status, changes: [{ path, diff, kind: { type: 'update' } }] }
  }
  const entries = projectCodexTurns([{ id: 'turn', status: 'completed', items: [
    edit('one', 'completed', 'a.txt', '@@ -1 +1 @@\n-old\n+middle'),
    edit('two', 'completed', 'a.txt', '@@ -1 +1 @@\n-middle\n+new'),
    edit('bad', 'declined', 'b.txt', '@@ -1 +1 @@\n-before\n+after'),
    edit('raw', 'completed', 'c.txt', 'opaque native patch'),
  ] }])
  let state
  for (const { event } of entries) {
    const match = codexTurnChanges.match(event)
    if (match?.role === 'start') state = codexTurnChanges.start({}, { event })
    if (match?.role === 'update') state = codexTurnChanges.update({ state }, { event })
  }
  const { value } = codexTurnChanges.buildLocationData({ state }, 'turn')
  assert.deepEqual(value.map(file => file.path), ['a.txt', 'c.txt'])
  assert.deepEqual(value[0].edits.map(change => change.diffs[0].newText), ['middle\n', 'new\n'])
  assert.equal(value[1].edits[0].raw, 'opaque native patch')
})
import { projectCodexTurns } from '../src/client/native-chat/events.js'

function turn(id, items, fields = {}) {
  return { id, startedAt: 100, completedAt: 200, status: 'completed', items, ...fields }
}

function types(entries, type) {
  return entries.map(({ event }) => event).filter(event => event.type === type)
}

test('projects native user, commentary, visible reasoning and final text in their original order', () => {
  const source = turn('turn-id', [
    { id: 'user-id', type: 'userMessage', startedAtMs: 100_012,
      content: [{ type: 'text', text: '  user\ntext  ' }, { type: 'mention', name: 'file', path: '/work/a' }] },
    { id: 'comment-id', type: 'agentMessage', phase: 'commentary', text: 'Checking **now**.', completedAtMs: 101_234 },
    { id: 'empty-id', type: 'reasoning', summary: [' '], content: ['Internal reasoning'] },
    { id: 'summary-id', type: 'reasoning', summary: ['First paragraph.', ' ', 'Second paragraph.'] },
    { id: 'answer-id', type: 'agentMessage', phase: 'final_answer', text: 'final\n', completedAtMs: 199_900 },
  ])
  const entries = projectCodexTurns([source], { beforeSeq: 100, beforeTurn: 10, provider: 'openai', model: 'codex-model' })
  const [start] = types(entries, 'turn/start')
  const [end] = types(entries, 'turn/end')
  const [user] = types(entries, 'user/message')
  const assistants = types(entries, 'assistant/message')
  assert.equal(start.time, 100_000)
  assert.equal(start.data.codexTurnId, 'turn-id')
  assert.equal(end.time, 200_000)
  assert.equal(end.data.turn, 9)
  assert.equal(user.data.id, 'user-id')
  assert.equal(user.time, 100_012)
  assert.deepEqual(user.data.content, [{ type: 'text', text: '  user\ntext  ' }, { type: 'text', text: '/work/a' }])
  assert.deepEqual(assistants.map(({ data }) => [data.message.id, data.codexPhase, data.message.content]), [
    ['comment-id', 'commentary', [{ type: 'text', text: 'Checking **now**.' }]],
    ['summary-id', undefined, [{ type: 'reasoning', text: 'First paragraph.\n\n \n\nSecond paragraph.' }]],
    ['answer-id', 'final_answer', [{ type: 'text', text: 'final\n' }]],
  ])
  assert.deepEqual(assistants[0].data.message.source, { kind: 'model', provider: 'openai', model: 'codex-model' })
  assert.equal(assistants[0].time, 101_234)
  assert.equal(assistants[2].time, 199_900)
  assert.equal(typeof assistants[0].data.stream.length, 'number')
  assert.equal(new Set(assistants.map(({ data }) => data.step)).size, 3)
  assert.equal(types(entries, 'step/start')[0].data.step, 1)
  assert.ok(entries.every((entry, i) => entry.type === 'event' && entry.event.seq === 100 - entries.length + i))
})

test('projects command output and parsed or raw file changes into DSH tool entries', () => {
  const entries = projectCodexTurns([turn('turn-id', [
    { id: 'command-id', type: 'commandExecution', command: 'example --flag', cwd: '/work',
      status: 'failed', aggregatedOutput: 'native output\n', exitCode: 7, startedAtMs: 101_001, completedAtMs: 102_001 },
    { id: 'diff-id', type: 'fileChange', status: 'completed', changes: [
      { path: 'a.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
      { path: 'b.txt', kind: { type: 'add' }, diff: 'new file\n' },
    ] },
    { id: 'raw-id', type: 'fileChange', status: 'completed', changes: [
      { path: 'raw', kind: { type: 'update' }, diff: 'unparsed patch' },
    ] },
  ])])
  const [command, parsed, raw] = types(entries, 'tool/call')
  const [commandResult, parsedResult, rawResult] = types(entries, 'tool/result')
  assert.equal(command.data.name, 'bash')
  assert.equal(command.data.callId, 'command-id')
  assert.equal(JSON.parse(command.data.arguments).command, 'example --flag')
  assert.equal(command.time, 101_001)
  assert.equal(commandResult.time, 102_001)
  assert.equal(commandResult.data.message.source.callId, 'command-id')
  assert.equal(commandResult.data.message.content[0].text, 'native output\n\n[exit code: 7]')
  assert.equal(commandResult.data.message.isError, false)
  assert.equal(commandResult.data.meta.cwd, '/work')
  assert.equal(parsed.data.name, 'edit')
  assert.equal(parsed.data.callId, 'diff-id')
  assert.deepEqual(parsedResult.data.meta.diffs, [
    { path: 'a.txt', oldText: 'old\n', newText: 'new\n' },
    { path: 'b.txt', oldText: null, newText: 'new file\n' },
  ])
  assert.equal(raw.data.name, 'fileChange')
  assert.equal(rawResult.data.message.content[0].text, 'raw\nunparsed patch')
})

test('older pages prepend without changing previously published sequence or turn identities', () => {
  const first = turn('older-turn', [{ id: 'older-message', type: 'agentMessage', text: 'Older' }])
  const second = turn('newer-turn', [{ id: 'newer-message', type: 'agentMessage', text: 'Newer' }])
  const recent = projectCodexTurns([second])
  const { seq, data } = recent[0].event
  const older = projectCodexTurns([first], { beforeSeq: seq, beforeTurn: data.turn })
  assert.deepEqual([...older, ...recent], projectCodexTurns([first, second]))
  assert.ok(older[0].event.seq > 0)
  assert.deepEqual(projectCodexTurns([]), [])
})

test('uses known dates for older records and preserves failed, interrupted and still-running turns', () => {
  const entries = projectCodexTurns([
    turn('failed', [{ id: 'legacy', type: 'userMessage', content: [{ type: 'text', text: 'legacy' }] }],
      { status: 'failed', error: { message: 'Native error message' }, startedAt: null, completedAt: null }),
    turn('interrupted', [], { status: 'interrupted', error: { message: 'Native interruption' } }),
    turn('active', [{ id: 'active-tool', type: 'mcpToolCall', tool: 'nativeTool', status: 'inProgress', arguments: {} }],
      { status: 'inProgress', completedAt: null }),
  ], { createdAt: 95 })
  assert.equal(types(entries, 'user/message')[0].time, 95_000)
  assert.deepEqual(types(entries, 'turn/end').map(({ data }) => data.reason), [
    { kind: 'error', error: { code: 'UNKNOWN', message: 'Native error message' } },
    { kind: 'aborted', reason: { kind: 'legacy' } },
  ])
  assert.deepEqual(types(entries, 'turn/end')[1].data.codexError, { message: 'Native interruption' })
  assert.equal(types(entries, 'tool/call')[0].data.name, 'nativeTool')
  assert.equal(types(entries, 'tool/result').length, 0)
  assert.equal(entries.at(-1).event.type, 'tool/call')
})
