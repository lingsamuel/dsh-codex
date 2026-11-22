import assert from 'node:assert/strict'
import test from 'node:test'
import { codexTurnChanges } from '../src/client/native-chat/turn-changes.js'
import { visualizeFence } from '../src/client/native-chat/visualize.js'

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

test('压缩进行中使用原生生命周期，重开会话可看到完成状态', () => {
  const item = { id: 'compact', type: 'contextCompaction' }
  const running = projectCodexTurns([turn('turn', [item], { status: 'inProgress' })])
  assert.deepEqual(types(running, 'compaction/start').map(({ data }) => data.compactionId), ['compact'])
  assert.equal(types(running, 'compaction/end').length, 0)
  const finished = projectCodexTurns([turn('turn', [{ ...item, completedAtMs: 199_000 }])])
  assert.deepEqual(types(finished, 'compaction/end').map(({ data }) => data.compactionId), ['compact'])
})

test('原生审查目标和完成结果分别以进度与 Markdown 回复投影', () => {
  const entries = projectCodexTurns([turn('review', [
    { id: 'begin', type: 'enteredReviewMode', review: 'current changes' },
    { id: 'end', type: 'exitedReviewMode', review: '**Regression** in [entry](/work/a.js:4).' },
  ])])
  const [started, completed] = types(entries, 'assistant/message')
  assert.equal(started.data.codexPhase, 'commentary')
  assert.equal(started.data.message.content[0].text, 'current changes')
  assert.equal(completed.data.codexPhase, 'final_answer')
  assert.match(completed.data.message.content[0].text, /^\*\*Regression\*\* in \[entry\]/)
})

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

function replyEnvelope(value) {
  return `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`
}

test('将 Codex 原生提问与后续问答交给 DSH 渲染，保留普通输入以及问答 ID', () => {
  const reply = { questionItemId: '["request_user_input_async","question-source",0]', question: '环境？', answer: '测试环境' }
  const second = { questionItemId: 'desktop-legacy-source', question: '补充信息？', answer: '需要数据备份' }
  const nativeReply = replyEnvelope([reply, second])
  const entries = projectCodexTurns([
    turn('ask', [{ id: 'question-source', type: 'agentMessage', delivery: 'async', text: '请确认。', questions: [
      { title: reply.question, options: ['测试环境', '正式环境'] }, { title: second.question, options: null },
    ] }]),
    turn('reply', [
      { id: 'standalone-reply', type: 'userMessage', startedAtMs: 100_040, completedAtMs: 100_060,
        content: [{ type: 'text', text: `# Context from my IDE setup:\n\n## My request for Codex:\n${nativeReply}` },
          { type: 'mention', name: 'backup', path: '/work/backup.md' }] },
      { id: 'ordinary-user', type: 'userMessage', content: [{ type: 'text', text: `这是示例：${nativeReply}` }] },
      { id: 'ordinary-model', type: 'agentMessage', text: '完成。' },
    ]),
  ])
  const [question, final] = types(entries, 'assistant/message')
  assert.match(question.data.message.content[0].text, /^请确认。\n\n\*\*环境？\*\*\n\n- 测试环境\n- 正式环境\n\n\*\*补充信息？\*\*$/)
  assert.equal(final.data.message.content[0].text, '完成。')
  const [call] = types(entries, 'tool/call')
  const [result] = types(entries, 'tool/result')
  assert.equal(call.data.name, 'ask_user_question')
  assert.equal(call.data.callId, 'standalone-reply')
  assert.equal(call.time, 100_040)
  assert.equal(result.time, 100_060)
  assert.equal(result.data.meta.codexQuestionReply, true)
  const { questions } = JSON.parse(call.data.arguments)
  assert.deepEqual(questions.map(question => question.question), [reply.question, second.question])
  assert.deepEqual(JSON.parse(result.data.message.content[0].text), { answers: [
    { id: questions[0].id, selected: [], custom: reply.answer },
    { id: questions[1].id, selected: [], custom: second.answer },
  ] })
  assert.deepEqual(types(entries, 'user/message').map(({ data }) => data.id), ['ordinary-user'])
})

test('单条旧版问答可独立显示，问题没有附带自然语言正文时仍会显示', () => {
  const entries = projectCodexTurns([turn('question-only', [
    { id: 'question-source', type: 'agentMessage', text: '', questions: [{ title: 'Choose *literally*', options: null }] },
    { id: 'answer', type: 'userMessage', content: [{ type: 'text', text: replyEnvelope({
      questionItemId: 'question-source', question: 'Choose *literally*', answer: 'Choice',
    }) }] },
  ])])
  assert.equal(types(entries, 'assistant/message')[0].data.message.content[0].text, '**Choose \\*literally\\***')
  assert.equal(types(entries, 'tool/result')[0].data.message.id, 'answer')
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

test('Codex 协作等待进入 DSH 原生等待工具行，保留目标、结果和超时状态', () => {
  const wait = {
    type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['child'],
    agentsStates: { child: { status: 'completed', message: '检查完成' } },
  }
  const entries = projectCodexTurns([turn('wait', [
    { ...wait, id: 'waiting', status: 'inProgress', agentsStates: {} },
    { ...wait, id: 'returned', status: 'completed' },
    { ...wait, id: 'timeout', status: 'completed', receiverThreadIds: [], agentsStates: {} },
    { ...wait, id: 'failed', status: 'failed', agentsStates: { child: { status: 'errored', message: '任务失败' } } },
    { id: 'mcp', type: 'mcpToolCall', tool: 'wait', status: 'completed', arguments: { seconds: 1 }, result: 'done' },
  ], { status: 'inProgress' })])
  const calls = types(entries, 'tool/call').map(({ data }) => [data.callId, data.name, JSON.parse(data.arguments)])
  assert.deepEqual(calls, [
    ['waiting', 'wait_agent', { targets: ['child'] }],
    ['returned', 'wait_agent', { targets: ['child'] }],
    ['timeout', 'wait_agent', { targets: [] }],
    ['failed', 'wait_agent', { targets: ['child'] }],
    ['mcp', 'wait', { seconds: 1 }],
  ])
  const [returned, timeout, failure, mcp] = types(entries, 'tool/result').map(({ data }) => data.message)
  assert.deepEqual(JSON.parse(returned.content[0].text).agentsStates, wait.agentsStates)
  assert.equal(JSON.parse(returned.content[0].text).timedOut, false)
  assert.equal(JSON.parse(timeout.content[0].text).timedOut, true)
  assert.equal(failure.isError, true)
  assert.equal(JSON.parse(failure.content[0].text).timedOut, false)
  assert.equal(mcp.content[0].text, 'done')
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

test('在助手正文原位投影 Visualize，原样保留用户输入和代码中的引用', () => {
  const moon = 'visualize{"path":"/work/moon phases.html"}'
  const wide = 'visualize{"path":"/work/compare.html","mode":"wide","title":"比较"}'
  const invalid = 'visualize{"path":"relative.html"}'
  const examples = ['```codex-visualize', moon, '```', '', `    ${wide}`, '', '`code', moon, 'example`', '', '<!--', wide, '-->'].join('\n')
  const input = [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: moon }] },
    { id: 'assistant', type: 'agentMessage', text: `说明\n${moon}\n中间\n${wide}\n\n${examples}\n\n${invalid}` },
  ]
  const entries = projectCodexTurns([turn('visualize', input)])
  assert.equal(types(entries, 'user/message')[0].data.content[0].text, moon)
  assert.equal(types(entries, 'assistant/message')[0].data.message.content[0].text,
    `说明\n\n\`\`\`${visualizeFence}\n${moon}\n\`\`\`\n\n中间\n\n\`\`\`${visualizeFence}\n${wide}\n\`\`\`\n\n${examples}\n\n${invalid}`)
})

test('识别紧跟 Markdown 引用段落或列表的独立 Visualize 行', () => {
  const reference = 'visualize{"path":"/work/example.html"}'
  for (const paragraph of ['> 摘要', '- 摘要']) {
    const entries = projectCodexTurns([turn('visualize', [{ id: 'reply', type: 'agentMessage', text: `${paragraph}\n${reference}` }])])
    assert.equal(types(entries, 'assistant/message')[0].data.message.content[0].text,
      `${paragraph}\n\n\`\`\`${visualizeFence}\n${reference}\n\`\`\``)
  }
})

test('与取消记录同 ID 的未完成命令保留原生命令，只补充取消结果', () => {
  const call = { id: 'shell', name: 'exec_command', input: '{"cmd":"pwd"}', output: 'Wall time: 0.02 seconds\naborted by user', completedAtMs: 101 }
  const finished = { ...call, id: 'finished' }
  const turns = [{ id: 'turn', status: 'interrupted', items: [
    { id: 'shell', type: 'commandExecution', command: 'pwd', cwd: '/workspace', status: 'inProgress' },
    { id: 'finished', type: 'commandExecution', command: 'true', cwd: '/workspace', status: 'completed', aggregatedOutput: 'native result' },
  ] }]
  const entries = projectCodexTurns(turns, { cancelledToolCalls: new Map([['turn', [call, finished]]]) })
  const results = entries.filter(({ event }) => event.type === 'tool/result')
  assert.deepEqual(results.map(({ event }) => event.data.message.id), ['shell', 'finished'])
  assert.match(results[0].event.data.message.content[0].text, /aborted by user/)
  assert.equal(results[0].event.data.message.isError, true)
  assert.match(results[1].event.data.message.content[0].text, /native result/)
  assert.equal(JSON.parse(entries.find(({ event }) => event.type === 'tool/call').event.data.arguments).command, 'pwd')
})
