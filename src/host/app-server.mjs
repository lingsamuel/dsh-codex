import { execFile } from 'node:child_process'
import { on, once } from 'node:events'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const run = promisify(execFile)

export class CodexRpcError extends Error {
  constructor({ message, code }) {
    super(message)
    this.code = code
  }
}

export async function findCodexSocket(signal) {
  const executable = process.env.DSH_CHATGPT_CODEX_BIN || 'codex'
  const { stdout } = await run(executable, ['app-server', 'daemon', 'version'], { signal })
  const daemon = JSON.parse(stdout)
  if (daemon.status !== 'running' || !daemon.socketPath) {
    throw new Error('当前环境没有可连接的 Codex App Server。')
  }
  return daemon.socketPath
}

/** 同一批只读请求共用一次握手，批次完成或取消后释放连接。 */
export async function withCodexReader(socketPath, requestSignal, read, timeoutMs = 15_000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout
  const endpoint = socketPath || await findCodexSocket(signal)
  signal.throwIfAborted()
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection({ path: endpoint }),
    maxPayload: 64 * 1024 * 1024,
  })
  let messages
  let nextId = 0

  async function request(method, params) {
    signal.throwIfAborted()
    const id = ++nextId
    ws.send(JSON.stringify({ id, method, params }))
    // Codex 可以在回应之间发送通知或服务端请求，按 ID 和响应形状匹配。
    while (true) {
      const { done, value } = await messages.next()
      if (done) throw new Error('Codex App Server 已断开。')
      const reply = JSON.parse(value[0].toString())
      if (reply.id !== id) continue
      if (reply.error) throw new CodexRpcError(reply.error)
      if ('result' in reply) return reply.result
    }
  }

  try {
    messages = on(ws, 'message', { signal, close: ['close'] })
    await once(ws, 'open', { signal })
    await request('initialize', {
      clientInfo: { name: 'dsh_chatgpt', title: 'DSH ChatGPT', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    ws.send(JSON.stringify({ method: 'initialized' }))
    return await read(request)
  } finally {
    // 连接在握手期间取消也可能异步产生 error，此时请求已经结束。
    ws.once('error', () => {})
    ws.terminate()
    await messages?.return()
  }
}

export function readCodex(method, params, socketPath, signal) {
  return withCodexReader(socketPath, signal, request => request(method, params))
}
