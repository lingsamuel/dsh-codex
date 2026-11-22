import { fileURLToPath } from 'node:url'
import { CodexRpcError, findCodexSocket } from './app-server.mjs'

export const codexTaskToolsServerName = 'dsh_codex_tasks'
const toolProgram = fileURLToPath(new URL('./codex-task-tools.mjs', import.meta.url))
const taskServers = [codexTaskToolsServerName, 'codex_tui', 'codex_app']

/** Codex 按线程启动 stdio 进程。三项委派操作沿用原版 TUI 的审批配置。 */
export function codexTaskToolsConfig(socketPath) {
  return {
    ['mcp_servers.' + codexTaskToolsServerName]: {
      command: process.execPath,
      args: [toolProgram, socketPath],
      default_tools_approval_mode: 'approve',
      tools: {
        create_thread: { approval_mode: 'prompt' },
        send_message_to_thread: { approval_mode: 'prompt' },
        fork_thread: { approval_mode: 'prompt' },
      },
      // wait_threads 的原生最长等待为两分钟，给最后一次状态读取留出时间。
      tool_timeout_sec: 130,
    },
  }
}

export async function threadTaskToolsConfig(socketPath, signal) {
  return codexTaskToolsConfig(socketPath ?? await findCodexSocket(signal))
}

export async function hasThreadReadTool(request, threadId) {
  for (const serverName of taskServers) {
    const { data } = await request('mcpServerStatus/list', { threadId, serverName, detail: 'toolsAndAuthOnly' })
    if (data?.some(server => server.name === serverName && server.runtimeStatus === 'connected'
      && !server.toolsError && Object.hasOwn(server.tools ?? {}, 'read_thread'))) return true
  }
  return false
}

export async function requireThreadReadTool(request, threadId) {
  if (await hasThreadReadTool(request, threadId)) return
  throw new CodexRpcError({ code: -32600, message: '当前会话缺少可用的历史读取工具。可以保留引用草稿，或移除引用后继续发送。',
    data: { reason: 'thread-read-tool-unavailable' } })
}
