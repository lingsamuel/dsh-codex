import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { dshTrajectorySource } from '../scripts/dsh-trajectory.mjs'
import { projectCodexTurns } from '../src/client/native-chat/events.js'
import { trajectoryCoordinates, trajectoryTurnNumber } from '../src/client/native-chat/trajectory.js'

const layoutSource = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-ui-trajectory/src/client/layout.ts'))
const { outputFiles } = await build({
  entryPoints: [layoutSource], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [await dshTrajectorySource()],
})
const { deriveTrajectoryLayout } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)

function translate(key, { step } = {}) {
  return step === undefined ? key : `Step ${step}`
}

test('原生轨迹把独立工具结果保留在当前 Codex 轮次和步骤', () => {
  const entries = projectCodexTurns([{ id: 'turn-id', status: 'completed', startedAt: 100, items: [
    { id: 'first', type: 'agentMessage', text: '正在查看目录' },
    { id: 'second', type: 'agentMessage', text: '现在执行命令' },
    { id: 'call-id', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0,
      startedAtMs: 101_000, completedAtMs: 102_000, aggregatedOutput: '/workspace' },
  ] }])
  const call = entries.find(({ event }) => event.type === 'tool/call').event
  const result = entries.find(({ event }) => event.type === 'tool/result').event
  const node = { kind: 'tool-result', seq: result.seq, time: result.time, callTime: call.time,
    callId: call.data.callId, call: { name: call.data.name, argsRaw: call.data.arguments },
    content: result.data.message.content, isError: false, subCalls: [] }
  const { locateTool } = trajectoryCoordinates(entries)
  const turns = deriveTrajectoryLayout({ nodes: [node], runningCalls: [], partial: null, locateTool }, translate)
  assert.deepEqual(turns.map(turn => [turn.turn, turn.groups[0].title, turn.groups[0].cells[0].callId]), [
    [call.data.turn, 'Step 2', call.data.callId],
  ])
})

test('轨迹用原调用定位 DSH 生成的中断结果', () => {
  const entries = projectCodexTurns([{ id: 'turn-id', status: 'interrupted', startedAt: 100, items: [
    { id: 'interrupted', type: 'commandExecution', command: 'pwd', status: 'inProgress', startedAtMs: 101_000 },
  ] }])
  const call = entries.find(({ event }) => event.type === 'tool/call').event
  const stepEnd = entries.find(({ event }) => event.type === 'step/end').event
  const { locateTool } = trajectoryCoordinates(entries)
  assert.deepEqual(locateTool({ seq: stepEnd.seq - 0.8, callId: call.data.callId }), { turn: call.data.turn, step: 1 })
  assert.equal(locateTool({ seq: stepEnd.seq - 0.8, callId: 'another-call' }), undefined)
})

test('旧轨迹快照的定位查询忽略后续增量追加', () => {
  const entries = projectCodexTurns([{ id: 'current', status: 'completed', items: [] }])
  const old = trajectoryCoordinates(entries)
  const later = projectCodexTurns([{ id: 'following', status: 'completed', items: [
    { id: 'later-call', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0 },
  ] }], { firstSeq: entries.at(-1).event.seq + 1, beforeTurn: entries[0].event.data.turn + 2 })
  entries.push(...later)
  const { seq, data } = later.find(({ event }) => event.type === 'tool/result').event
  const tool = { seq, callId: data.message.source.callId }
  assert.equal(old.locateTool(tool), undefined)
  assert.deepEqual(trajectoryCoordinates(entries).locateTool(tool), { turn: data.turn, step: data.step })
})

test('补入旧轮次后轨迹显示新的顺序，原事件仍使用相同的轮次和 ID', () => {
  const newest = projectCodexTurns([{ id: 'newest', status: 'completed', items: [] }])
  const { data, seq } = newest[0].event
  const earlier = projectCodexTurns([{ id: 'earlier', status: 'completed', items: [] }],
    { beforeSeq: seq, beforeTurn: data.turn })
  assert.equal(trajectoryTurnNumber(trajectoryCoordinates(newest).firstTurn, data.turn), 1)
  const { firstTurn } = trajectoryCoordinates([...earlier, ...newest])
  assert.equal(trajectoryTurnNumber(firstTurn, earlier[0].event.data.turn), 1)
  assert.equal(trajectoryTurnNumber(firstTurn, data.turn), 2)
  assert.equal(newest[0].event.data.codexTurnId, 'newest')
})
