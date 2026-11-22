import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isDeepStrictEqual } from 'node:util'
import { permissionOf } from '../shared/permissions.js'
import { planModeOf } from '../shared/plan-mode.js'
import { goalCommandObjective } from '../shared/user-input.js'
import { goalCompletion } from '../shared/goal-completion.js'

const statuses = new Set(['pending', 'in_progress', 'completed'])
const userCancelled = /^(?:aborted by user(?: after \d[\d.msµnh ]*)?\.?|Wall time: \d+(?:\.\d+)? seconds\r?\naborted by user)\s*$/i

function normalizePlan(value) {
  if (!Array.isArray(value?.plan) || !value.plan.every(step => typeof step?.step === 'string' && statuses.has(step.status))) return
  return value.plan.map(({ step, status }) => ({ content: step, status }))
}

function readGoalToolResult(output, threadId, recordedGoal) {
  const parts = Array.isArray(output) ? output.map(part => part.text) : [output]
  for (const part of parts) {
    if (typeof part !== 'string' || !part.includes('"goal"')) continue
    let value
    try { value = JSON.parse(part) } catch { continue }
    const goal = value?.goal
    if (!goal || goal.threadId !== threadId || (recordedGoal &&
      (goal.objective !== recordedGoal.objective || goal.createdAt !== recordedGoal.createdAt))) continue
    return goal
  }
}

function displayPermission(recorded, turn) {
  const permission = recorded?.permission
  const sandbox = turn?.permission.sandbox
  // 设置检查点保存完整规则，轮次还保存 Codex 给这些规则的沙箱名称。
  if (permission?.sandbox === 'managed' && sandbox && sandbox !== 'managed'
    && recorded.cwd && recorded.cwd === turn.cwd && recorded.profile && isDeepStrictEqual(recorded.profile, turn.profile)) {
    return { ...permission, sandbox }
  }
  return permission
}

/** 仅消费 Codex 原生 rollout 中已落盘的结构化事实。后续读取从上次字节位置继续。 */
export function createRolloutFacts(path, signal, threadId) {
  if (!path || !isAbsolute(path)) return undefined
  const pendingPlans = new Map()
  const pendingToolCalls = new Map()
  let turns = []
  let offset = 0
  let line = ''
  let decoder = new StringDecoder('utf8')
  let identity
  let generation = 0
  let settingsChanges = 0
  let ownedPermission
  let legacyPermission
  let savedPlanMode
  let followsOwner = false
  let permissionSequence = 0
  let recordedGoal
  let pendingGoalInput
  const previous = {}
  const pending = new Set()
  let queue = Promise.resolve()

  function currentTurn() {
    if (!turns.length) turns.push({})
    return turns.at(-1)
  }

  function recordPermission(settings) {
    const permission = permissionOf(settings, 'saved')
    if (permission) return { sequence: ++permissionSequence, permission, cwd: settings.cwd, profile: settings.permission_profile }
  }

  function consume(text) {
    if (!/task_started|turn_started|thread_rolled_back|thread_goal_(?:updated|cleared)|UserMessage|plan_update|update_plan|(?:create|update)_goal|function_call_output|token_count|thread_settings_applied|turn_context|custom_tool_call|exec_command|shell_command/.test(text)) return
    let record
    try { record = JSON.parse(text) } catch { return }
    const value = record.payload
    if (record.type === 'turn_context') {
      const turn = currentTurn()
      const turnId = value?.turn_id ?? turn.id
      // 上下文可能晚于下一轮的开始记录到达。按原生 ID 找回它所属的轮次。
      const owner = turn.id && turnId !== turn.id ? turns.findLast(candidate => candidate.id === turnId) : turn
      const permission = recordPermission(value)
      if (permission && owner) {
        owner.permission = { ...permission, turnId }
        pending.add('permission').add('turnPermission')
      }
      if (owner && typeof value?.cwd === 'string' && isAbsolute(value.cwd)) {
        owner.id ??= turnId
        owner.cwd = value.cwd
        pending.add('turnWorkingDirectories')
      }
      const mode = planModeOf(value)
      if (mode) {
        currentTurn().planMode = mode
        pending.add('planMode')
      }
      return
    }
    if (record.type === 'event_msg') {
      if (value?.type === 'task_started' || value?.type === 'turn_started') {
        if (!value.turn_id || turns.at(-1)?.id !== value.turn_id) {
          turns.push({ id: value.turn_id })
          pending.add('turnPermission')
        }
        if (value.turn_id && value.turn_attribution?.turn_trigger === 'goal' && pendingGoalInput) {
          currentTurn().goalInput = pendingGoalInput
          pendingGoalInput = undefined
          pending.add('goalInputs')
        }
        pendingPlans.clear()
        pendingToolCalls.clear()
      } else if (value?.type === 'thread_rolled_back' && Number.isSafeInteger(value.num_turns) && value.num_turns > 0) {
        turns.splice(Math.max(0, turns.length - value.num_turns))
        pendingPlans.clear()
        pendingToolCalls.clear()
        pendingGoalInput = undefined
        invalidateProjection()
      } else if (value?.type === 'thread_goal_updated' && value.threadId === threadId) {
        const goal = value.goal
        const objective = goal?.objective?.trim()
        if (goal?.status === 'active' && objective && (goal.createdAt !== recordedGoal?.createdAt || objective !== recordedGoal?.objective)) {
          // Codex 的自动目标轮次没有 UserMessage。只用目标写入和轮次归因恢复输入，用量更新不会生成气泡。
          const time = Date.parse(record.timestamp)
          pendingGoalInput = { objective, ...(Number.isFinite(time) && { time }) }
        }
        recordedGoal = objective && { objective, createdAt: goal.createdAt }
      } else if (value?.type === 'thread_goal_cleared' && value.threadId === threadId) {
        recordedGoal = pendingGoalInput = undefined
      } else if (value?.type === 'item_completed' && value.item?.type === 'UserMessage') {
        const objective = goalCommandObjective(value.item.content)
        const turn = turns.findLast(turn => turn.id === value.turn_id)
        if (!objective || !turn || !value.item.id) return
        const input = { objective, messageId: value.item.id }
        turn.goalMessage = input
        // 记录桌面端气泡的身份，使同一条消息既能高亮，也不会在自动续跑时重复出现。
        if (objective === pendingGoalInput?.objective) {
          turn.goalInput = { ...pendingGoalInput, ...input }
          pendingGoalInput = undefined
          pending.add('goalInputs')
        }
      } else if (value?.type === 'plan_update') {
        const plan = normalizePlan(value)
        if (plan) {
          currentTurn().todos = plan
          pending.add('todos')
        }
      } else if (value?.type === 'token_count') {
        const pressureTokens = value.info?.last_token_usage?.total_tokens
        const contextWindow = value.info?.model_context_window
        if (Number.isSafeInteger(pressureTokens) && pressureTokens >= 0 && Number.isSafeInteger(contextWindow) && contextWindow > 0) {
          // Codex 使用上一轮的 total_tokens 作为活跃上下文大小，整个会话的累计用量另有字段。
          currentTurn().contextPressure = { pressureTokens, contextWindow }
          pending.add('contextPressure')
        }
      } else if (value?.type === 'thread_settings_applied') {
        settingsChanges++
        pending.add('settingsStamp').add('planMode').add('permission')
        if (value.thread_id) followsOwner = value.thread_id === threadId
        if (followsOwner || !value.thread_id) savedPlanMode = planModeOf(value.thread_settings) ?? savedPlanMode
        const permission = recordPermission(value.thread_settings)
        if (!permission) return
        // 已开始的旧轮次可以晚写上下文。同一线程的完整设置检查点才是随后权限的依据。
        if (followsOwner) ownedPermission = permission
        if (!value.thread_id) legacyPermission = permission
      }
      return
    }
    if (record.type !== 'response_item' || !value?.call_id) return
    const goalCall = value.type === 'function_call' && !value.namespace && ['create_goal', 'update_goal'].includes(value.name)
      ? value.name
      : value.type === 'custom_tool_call' && value.name === 'exec'
        ? value.input?.match(/\btools\.(create_goal|update_goal)\s*\(/u)?.[1] : undefined
    const input = value.type === 'custom_tool_call' && value.name === 'exec' ? value.input
      : value.type === 'function_call' && (goalCall || ['exec_command', 'shell_command'].includes(value.name)) ? value.arguments : undefined
    if (typeof input === 'string' && currentTurn().id) {
      pendingToolCalls.set(value.call_id, { id: value.call_id, name: value.name, input, startedAtMs: Date.parse(record.timestamp),
        ...(goalCall && { goalCall }) })
    } else if (value.type === 'custom_tool_call_output' || value.type === 'function_call_output') {
      const call = pendingToolCalls.get(value.call_id)
      pendingToolCalls.delete(value.call_id)
      if (call?.goalCall) {
        // 桌面端可能在收到达成通知后清除目标。工具回执仍保存在原生轮次中。
        const turn = currentTurn()
        const created = call.goalCall === 'create_goal'
        const goal = readGoalToolResult(value.output, threadId, created ? undefined : recordedGoal)
        if (created && goal?.status === 'active' && turn.goalMessage && !turn.goalInput) {
          turn.goalInput = turn.goalMessage
          pending.add('goalInputs')
        }
        const completion = goalCompletion(goal)
        if (completion) {
          turn.goalCompletion = completion
          pending.add('goalCompletions')
        }
      }
      if (call && ['exec', 'exec_command', 'shell_command'].includes(call.name)
        && typeof value.output === 'string' && userCancelled.test(value.output)) {
        // 有些请求在执行前取消，Codex 只保留这对原始调用和返回，常规轮次没有工具项。
        const turn = currentTurn()
        turn.cancelledToolCalls ??= []
        const { goalCall, ...execution } = call
        turn.cancelledToolCalls.push({ ...execution, output: value.output, completedAtMs: Date.parse(record.timestamp) })
        pending.add('cancelledToolCalls')
      }
    }
    if (value.type === 'function_call' && value.name === 'update_plan' && !value.namespace) {
      try {
        const plan = normalizePlan(JSON.parse(value.arguments))
        if (plan) pendingPlans.set(value.call_id, plan)
      } catch { /* 未成功解码的调用没有可显示的计划。 */ }
    } else if (value.type === 'function_call_output') {
      const plan = pendingPlans.get(value.call_id)
      pendingPlans.delete(value.call_id)
      if (plan && value.output === 'Plan updated') {
        currentTurn().todos = plan
        pending.add('todos')
      }
    }
  }

  function collection(key, value) {
    // 只在曾有该字段时发出空集合，以清除客户端已保存的条目。
    const size = Array.isArray(value) ? value.length : Object.keys(value).length
    return size || Object.hasOwn(previous, key) ? value : undefined
  }

  const project = {
    todos: () => turns.findLast(turn => turn.todos !== undefined)?.todos,
    contextPressure: () => turns.findLast(turn => turn.contextPressure !== undefined)?.contextPressure,
    settingsStamp: () => settingsChanges ? `${generation}:${settingsChanges}` : undefined,
    permission() {
      const turn = turns.findLast(turn => turn.permission)?.permission
      const latest = (turn?.sequence ?? 0) > (legacyPermission?.sequence ?? 0) ? turn : legacyPermission
      return displayPermission(ownedPermission ?? latest, turn)
    },
    turnPermission() {
      const latest = turns.at(-1)?.permission
      if (latest?.turnId) return { turnId: latest.turnId, permission: latest.permission }
    },
    planMode: () => savedPlanMode ?? turns.findLast(turn => turn.planMode)?.planMode,
    cancelledToolCalls: () => collection('cancelledToolCalls', turns.flatMap(turn =>
      turn.cancelledToolCalls?.map(call => ({ ...call, turnId: turn.id })) ?? [])),
    turnWorkingDirectories: () => collection('turnWorkingDirectories', Object.fromEntries(
      turns.filter(({ id, cwd }) => id && cwd).map(({ id, cwd }) => [id, cwd]))),
    goalInputs: () => collection('goalInputs', Object.fromEntries(
      turns.filter(turn => turn.goalInput).map(({ id, goalInput }) => [id, goalInput]))),
    goalCompletions: () => collection('goalCompletions', Object.fromEntries(
      turns.filter(turn => turn.goalCompletion).map(({ id, goalCompletion }) => [id, goalCompletion]))),
  }

  function invalidateProjection() {
    for (const key of Object.keys(project)) pending.add(key)
  }

  async function scan(filePath, changesOnly) {
    signal.throwIfAborted()
    const file = await open(filePath, 'r')
    try {
      const { size, dev, ino } = await file.stat()
      // 连接可能在等待文件状态时关闭。用已取消的信号创建读流会提前触发流错误。
      signal.throwIfAborted()
      const current = `${dev}:${ino}`
      if (identity !== current || size < offset) {
        if (identity !== undefined) invalidateProjection()
        identity = current
        generation++
        settingsChanges = 0
        ownedPermission = legacyPermission = undefined
        savedPlanMode = undefined
        recordedGoal = pendingGoalInput = undefined
        followsOwner = false
        permissionSequence = 0
        turns = []
        pendingPlans.clear()
        pendingToolCalls.clear()
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
      // 每种记录只标记自己影响的字段。上下文用量变动时无需遍历旧轮次或序列化其元数据。
      const changes = {}
      for (const key of pending) {
        const value = project[key]()
        if (isDeepStrictEqual(value, previous[key])) continue
        if (value === undefined) delete previous[key]
        else previous[key] = value
        changes[key] = value ?? null
      }
      pending.clear()
      if (!Object.keys(changes).length) return null
      return changesOnly ? changes : { ...previous }
    } finally {
      await file.close()
    }
  }

  return {
    read({ path: filePath = path, changesOnly = false } = {}) {
      // 元数据是可选的。缺失的旧文件不会中断通过 App Server 读取的聊天。
      queue = queue.then(() => scan(filePath, changesOnly)).catch(() => null)
      return queue
    },
  }
}
