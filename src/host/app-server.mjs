import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const run = promisify(execFile)

export class CodexRpcError extends Error {
  constructor({ message, code, data }) {
    super(message)
    this.code = code
    this.data = data
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

/** 接收原生 RPC 回复、服务端请求与 daemon 广播。onMessage 同时收到原始消息的字节数。 */
export async function openCodexReader(socketPath, signal, onMessage = () => {}) {
  const setup = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const endpoint = socketPath || await findCodexSocket(setup)
  setup.throwIfAborted()
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection({ path: endpoint }),
    maxPayload: 64 * 1024 * 1024,
  })
  let nextId = 0
  let failure
  const pending = new Map()
  const { promise: closed, resolve: finish } = Promise.withResolvers()

  function close(error = new Error('Codex App Server 已断开。')) {
    if (failure) return
    failure = error
    signal.removeEventListener('abort', abort)
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
    ws.terminate()
    finish()
  }
  function abort() {
    close(signal.reason)
  }

  ws.on('error', close)
  ws.on('close', () => close())
  signal.addEventListener('abort', abort, { once: true })
  ws.on('message', data => {
    try {
      const message = JSON.parse(data.toString())
      if (typeof message.method === 'string') {
        onMessage(message, data.byteLength)
        return
      }
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new CodexRpcError(message.error))
      else waiter.resolve(message.result)
    } catch (error) {
      close(error)
    }
  })

  function request(method, params) {
    if (failure) return Promise.reject(failure)
    const id = ++nextId
    const { promise, resolve, reject } = Promise.withResolvers()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Codex App Server 未及时响应。'))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }), error => {
      if (error) close(error)
    })
    return promise
  }

  /** 沿同一连接回复 daemon 分配的原始请求 ID。对端通过通知报告请求何时结束。 */
  async function respond(id, result) {
    if (failure) throw failure
    await new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ id, result }), error => {
        if (error) {
          close(error)
          reject(error)
        } else resolve()
      })
    })
  }

  try {
    await once(ws, 'open', { signal: setup })
    // Codex 的 daemon 查询客户端标识不覆盖 CLI 正在使用的全局 originator 和 UA。
    const initialize = await request('initialize', {
      clientInfo: { name: 'codex_app_server_daemon', title: 'DSH ChatGPT', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    ws.send(JSON.stringify({ method: 'initialized' }))
    return { request, respond, initialize, close, closed }
  } catch (error) {
    close(error)
    throw error
  }
}

/** 同一批请求共用一次握手，批次完成或取消后释放连接。 */
export async function withCodexReader(socketPath, requestSignal, read, timeoutMs = 15_000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout
  const connection = await openCodexReader(socketPath, signal)
  try {
    return await read(connection.request)
  } finally {
    connection.close()
  }
}

export function readCodex(method, params, socketPath, signal) {
  return withCodexReader(socketPath, signal, request => request(method, params))
}

/** App Server 的 SQLite 目录可独立于 Codex 的会话目录配置。 */
export function codexSqliteHome(configResult, codexHome) {
  return configResult?.config?.sqlite_home || process.env.CODEX_SQLITE_HOME || codexHome
}

/** 按原生顺序逐页交付。消费者取下一页时才发下一次请求。 */
export async function* iterateCodexPages(read, cursor) {
  const cursors = new Set()
  do {
    const page = await read(cursor)
    if (cursor != null) cursors.add(cursor)
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('Codex 返回了重复的分页游标。')
    yield page
  } while (cursor)
}

/** 沿 Codex 返回的不透明游标收集完整结果，保留原生顺序。 */
export async function readCodexPages(read, cursor) {
  const entries = []
  for await (const { data } of iterateCodexPages(read, cursor)) entries.push(...data)
  return entries
}
