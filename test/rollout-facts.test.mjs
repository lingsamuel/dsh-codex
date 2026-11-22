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
