import { toDiffHunks } from '../file-change.js'

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

function fileChange(item) {
  const output = item.changes.map(({ path, diff }) => `${path}\n${diff}`).join('\n\n')
  const hunks = item.changes.map(toDiffHunks)
  const [first] = hunks[0] ?? []
  const isError = item.status === 'failed' || item.status === 'declined'
  // 原版 edit 工具行会在同一条结果中显示多文件差异。无法解析时保留原始补丁。
  if (first && hunks.every(Boolean)) {
    return {
      name: 'edit',
      args: { file_path: first.path, old_string: first.oldText ?? '', new_string: first.newText },
      output,
      meta: { diffs: hunks.flat(), codexStatus: item.status },
      isError,
    }
  }
  return { name: item.type, args: { paths: item.changes.map(change => change.path) }, output, isError }
}

/** 将原生命令、文件变更和工具输出交给 DSH 已注册的工具行。 */
export function projectTool(item) {
  switch (item.type) {
    case 'commandExecution':
      return command(item)
    case 'fileChange':
      return fileChange(item)
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
