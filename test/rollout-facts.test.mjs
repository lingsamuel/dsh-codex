import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createRolloutFacts } from '../src/host/rollout-facts.mjs'

test('只投影已确认的结构化计划，跟随追加并回放 Codex 回退', async t => {
  await mkdir('.runtime', { recursive: true })
  const dir = await mkdtemp(join(process.cwd(), '.runtime', 'facts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'native.jsonl')
  const line = (type, payload) => JSON.stringify({ type, payload }) + '\n'
  const event = (type, payload = {}) => line('event_msg', { type, ...payload })
  const call = (call_id, step) => line('response_item', {
    type: 'function_call', name: 'update_plan', call_id, arguments: JSON.stringify({ plan: [{ step, status: 'in_progress' }] }),
  })
  const result = (call_id, output) => line('response_item', { type: 'function_call_output', call_id, output })
  await writeFile(path, event('task_started') + call('first', '原计划') + result('first', 'Plan updated'))
  const reader = createRolloutFacts(path, new AbortController().signal)
  const first = await reader.read()
  assert.deepEqual(first.todos, [{ content: '原计划', status: 'in_progress' }])
  assert.equal(await reader.read(), null)

  const accepted = result('next', 'Plan updated')
  await appendFile(path, event('task_started') + call('failed', '应忽略') + result('failed', 'not allowed') + call('next', '新计划') + accepted.slice(0, -4))
  assert.equal(await reader.read(), null)
  await appendFile(path, accepted.slice(-4))
  assert.deepEqual((await reader.read()).todos, [{ content: '新计划', status: 'in_progress' }])
  await appendFile(path, event('thread_rolled_back', { num_turns: 1 }))
  assert.deepEqual(await reader.read(), first)
})

test('上下文表采用原生上次上下文总量和窗口容量', async t => {
  await mkdir('.runtime', { recursive: true })
  const dir = await mkdtemp(join(process.cwd(), '.runtime', 'context-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'native.jsonl')
  const frame = info => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info } }) + '\n'
  await writeFile(path, frame({
    last_token_usage: { input_tokens: 3000, total_tokens: 3500 },
    total_token_usage: { input_tokens: 90000 }, model_context_window: 10000,
  }))
  const reader = createRolloutFacts(path, new AbortController().signal)
  assert.deepEqual((await reader.read()).contextPressure, { pressureTokens: 3500, contextWindow: 10000 })
  await appendFile(path, frame(null))
  assert.equal(await reader.read(), null)
  await appendFile(path, frame({ last_token_usage: { total_tokens: 5000 }, model_context_window: 20000 }))
  assert.deepEqual((await reader.read()).contextPressure, { pressureTokens: 5000, contextWindow: 20000 })
})

test('读取文件状态期间取消 rollout 扫描会安全结束', async t => {
  await mkdir('.runtime', { recursive: true })
  const dir = await mkdtemp(join(process.cwd(), '.runtime', 'facts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'native.jsonl')
  await writeFile(path, JSON.stringify({ type: 'event_msg', payload: {
    type: 'plan_update', plan: [{ step: '正在运行', status: 'in_progress' }],
  } }) + '\n')

  const abort = new AbortController()
  const file = await open(path, 'r')
  const prototype = Object.getPrototypeOf(file)
  const { stat } = prototype
  await file.close()
  t.mock.method(prototype, 'stat', async function (...args) {
    const info = await stat.apply(this, args)
    abort.abort()
    return info
  })

  const reader = createRolloutFacts(path, abort.signal)
  assert.equal(await reader.read(), null)
  // 等待读流可能延后触发的 error 事件，由测试运行器捕获未处理异常。
  await setImmediate()
})

test('从原生记录回放已取消的工具调用，并沿原轮次回退', async t => {
  const target = await mkdtemp(join(process.cwd(), '.runtime', 'cancelled-tool-'))
  t.after(() => rm(target, { recursive: true, force: true }))
  const path = join(target, 'rollout.jsonl')
  const signal = new AbortController().signal
  const input = 'const r=await tools.exec_command({cmd:"pwd",sandbox_permissions:"require_escalated"});text(r);'
  const line = (type, payload, timestamp) => JSON.stringify({ type, payload, timestamp }) + '\n'
  const rows = [
    line('event_msg', { type: 'task_started', turn_id: 'turn-a' }),
    line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'successful', input: 'other' }),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'successful', output: 'completed' }),
    line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'cancelled', input }, '2026-11-22T12:48:46.681Z'),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'cancelled', output: 'aborted by user after 8.9s' }, '2026-11-22T12:48:55.616Z'),
  ]
  await writeFile(path, rows.slice(0, -1).join(''))
  const facts = createRolloutFacts(path, signal)
  assert.equal(await facts.read(), null)
  await appendFile(path, rows.at(-1))
  assert.deepEqual((await facts.read()).cancelledToolCalls, [
    { turnId: 'turn-a', id: 'cancelled', name: 'exec', input, output: 'aborted by user after 8.9s',
      startedAtMs: Date.parse('2026-11-22T12:48:46.681Z'), completedAtMs: Date.parse('2026-11-22T12:48:55.616Z') },
  ])
  assert.equal(await facts.read(), null)
  const directInput = JSON.stringify({ cmd: 'pwd' })
  const directOutput = 'Wall time: 0.02 seconds\naborted by user'
  await appendFile(path, line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'direct', arguments: directInput })
    + line('response_item', { type: 'function_call_output', call_id: 'direct', output: directOutput }))
  const direct = (await facts.read()).cancelledToolCalls.find(call => call.id === 'direct')
  assert.deepEqual({ turnId: direct?.turnId, input: direct?.input, output: direct?.output }, { turnId: 'turn-a', input: directInput, output: directOutput })
  await appendFile(path, line('event_msg', { type: 'thread_rolled_back', num_turns: 1 }))
  assert.deepEqual((await facts.read()).cancelledToolCalls, [])
})
