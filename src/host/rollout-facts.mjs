import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const statuses = new Set(['pending', 'in_progress', 'completed'])

function normalizePlan(value) {
  if (!Array.isArray(value?.plan) || !value.plan.every(step => typeof step?.step === 'string' && statuses.has(step.status))) return
  return value.plan.map(({ step, status }) => ({ content: step, status }))
}

/** 仅消费 Codex 原生 rollout 中已落盘的结构化事实。后续读取从上次字节位置继续。 */
export function createRolloutFacts(path, signal) {
  if (!path || !isAbsolute(path)) return undefined
  const pendingPlans = new Map()
  let turns = []
  let offset = 0
  let line = ''
  let decoder = new StringDecoder('utf8')
  let identity
  let generation = 0
  let settingsChanges = 0
  let previous = '{}'
  let queue = Promise.resolve()

  function currentTurn() {
    if (!turns.length) turns.push({})
    return turns.at(-1)
  }

  function consume(text) {
    if (!/task_started|turn_started|thread_rolled_back|plan_update|update_plan|function_call_output|token_count|thread_settings_applied/.test(text)) return
    let record
    try { record = JSON.parse(text) } catch { return }
    const value = record.payload
    if (record.type === 'event_msg') {
      if (value?.type === 'task_started' || value?.type === 'turn_started') {
        turns.push({})
        pendingPlans.clear()
      } else if (value?.type === 'thread_rolled_back' && Number.isSafeInteger(value.num_turns) && value.num_turns > 0) {
        turns.splice(Math.max(0, turns.length - value.num_turns))
        pendingPlans.clear()
      } else if (value?.type === 'plan_update') {
        const plan = normalizePlan(value)
        if (plan) currentTurn().todos = plan
      } else if (value?.type === 'token_count') {
        const pressureTokens = value.info?.last_token_usage?.total_tokens
        const contextWindow = value.info?.model_context_window
        if (Number.isSafeInteger(pressureTokens) && pressureTokens >= 0 && Number.isSafeInteger(contextWindow) && contextWindow > 0) {
          // Codex 使用上一轮的 total_tokens 作为活跃上下文大小，整个会话的累计用量另有字段。
          currentTurn().contextPressure = { pressureTokens, contextWindow }
        }
      } else if (value?.type === 'thread_settings_applied') {
        settingsChanges++
      }
      return
    }
    if (record.type !== 'response_item' || !value?.call_id) return
    if (value.type === 'function_call' && value.name === 'update_plan' && !value.namespace) {
      try {
        const plan = normalizePlan(JSON.parse(value.arguments))
        if (plan) pendingPlans.set(value.call_id, plan)
      } catch { /* 未成功解码的调用没有可显示的计划。 */ }
    } else if (value.type === 'function_call_output') {
      const plan = pendingPlans.get(value.call_id)
      pendingPlans.delete(value.call_id)
      if (plan && value.output === 'Plan updated') currentTurn().todos = plan
    }
  }

  async function scan() {
    signal.throwIfAborted()
    const file = await open(path, 'r')
    try {
      const { size, dev, ino } = await file.stat()
      const current = `${dev}:${ino}`
      if (identity !== current || size < offset) {
        identity = current
        generation++
        settingsChanges = 0
        turns = []
        pendingPlans.clear()
        offset = 0
        line = ''
        decoder = new StringDecoder('utf8')
      }
      if (size > offset) {
        for await (const chunk of file.createReadStream({ start: offset, end: size - 1, autoClose: false, signal })) {
          offset += chunk.length
          const lines = (line + decoder.write(chunk)).split('\n')
          line = lines.pop()
          for (const text of lines) consume(text)
        }
      }
      const facts = {
        todos: turns.findLast(turn => turn.todos !== undefined)?.todos,
        contextPressure: turns.findLast(turn => turn.contextPressure !== undefined)?.contextPressure,
        settingsStamp: settingsChanges ? `${generation}:${settingsChanges}` : undefined,
      }
      const serialized = JSON.stringify(facts)
      if (serialized === previous) return null
      previous = serialized
      return facts
    } finally {
      await file.close()
    }
  }

  return {
    read() {
      // 元数据是可选的。缺失的旧文件不会中断通过 App Server 读取的聊天。
      queue = queue.then(scan).catch(() => null)
      return queue
    },
  }
}
