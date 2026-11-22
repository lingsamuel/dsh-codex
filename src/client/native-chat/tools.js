import { toDiffHunks } from '../file-change.js'
import { scopeTurnFile } from './file-links.js'

function command(item) {
  const { command, cwd, aggregatedOutput, exitCode } = item
  return {
    name: 'bash',
    // RC.2 用 description 区分独立命令与持久终端，用末行标记还原退出码。
    args: { command, description: command, workdir: cwd },
    output: `${aggregatedOutput ?? ''}\n[exit code: ${exitCode ?? 'null'}]`,
    meta: { cwd, codexStatus: item.status },
    isError: item.status === 'declined' || (item.status === 'failed' && exitCode == null),
  }
}

function fileChange(item, cwd) {
  const output = item.changes.map(({ path, diff }) => `${path}\n${diff}`).join('\n\n')
  const changes = item.changes.map(change => ({ ...change, path: scopeTurnFile(change.path, cwd) }))
  const hunks = changes.map(toDiffHunks)
  const [first] = hunks[0] ?? []
  const isError = item.status === 'failed' || item.status === 'declined'
  const meta = {
    codexStatus: item.status,
    // 回合总览和工具行共享同一批解析结果，同时保留无法解析的原生补丁。
    codexFileChanges: changes.map(({ path, diff }, index) => ({
      path, diffs: hunks[index] ?? [], raw: hunks[index] ? undefined : diff,
    })),
  }
  // 原版 edit 工具行会在同一条结果中显示多文件差异。无法解析时保留原始补丁。
  if (first && hunks.every(Boolean)) {
    return {
      name: 'edit',
      args: { file_path: first.path, old_string: first.oldText ?? '', new_string: first.newText },
      output,
      meta: { ...meta, diffs: hunks.flat() },
      isError,
    }
  }
  return { name: item.type, args: { paths: changes.map(change => change.path) }, output, meta, isError }
}

/** 原生问答事件本身已经记载问题和回答，使用 DSH 已安装的只读问答工具卡。 */
export function projectQuestionReply(replies) {
  const questions = replies.map(({ questionItemId, question }, index) => ({ id: String(index), question, questionItemId }))
  const answers = replies.map(({ answer }, index) => ({ id: questions[index].id, selected: [], custom: answer }))
  return {
    name: 'ask_user_question',
    args: { questions },
    output: JSON.stringify({ answers }),
    meta: { codexQuestionReply: true },
    isError: false,
  }
}

function agentWait(item) {
  const { receiverThreadIds = [], agentsStates, status } = item
  // Codex 正常结束等待却没有返回任何子智能体状态时，表示已到达等待时限。
  const timedOut = status === 'completed' && agentsStates != null && Object.keys(agentsStates).length === 0
  return {
    name: 'wait_agent',
    args: { targets: receiverThreadIds },
    output: JSON.stringify({ ...item, timedOut }, null, 2),
    isError: status === 'failed',
  }
}

/** 将原生命令、文件变更和工具输出交给 DSH 已注册的工具行。 */
export function projectTool(item, cwd) {
  if (item.type === 'collabAgentToolCall' && item.tool === 'wait') return agentWait(item)
  switch (item.type) {
    case 'cancelledToolCall':
      return { name: item.name, args: { input: item.input }, output: item.output, isError: true }
    case 'commandExecution':
      return command(item)
    case 'fileChange':
      return fileChange(item, cwd)
    case 'webSearch':
      return { name: 'web_search', args: { query: item.query }, output: item.query, isError: false }
    default: {
      const result = item.result ?? item.contentItems ?? item.output ?? item.error ?? item
      return {
        name: item.tool ?? item.name ?? item.type,
        args: item.arguments ?? {},
        output: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        isError: item.status === 'failed' || item.status === 'declined' || item.success === false,
      }
    }
  }
}
