import { randomUUID } from 'node:crypto'
import { openCodexReader, readCodex, readCodexPages, withCodexReader } from './app-server.mjs'
import { createCodexCapabilityRoute, invalidCapabilityRequest, requiredValue } from './codex-capability-route.mjs'
import { externalWebUrl } from '../shared/external-url.js'

const loginTimeoutSecs = 300

/** 授权由 Codex 完成。只保留有期限的结果，以原生 loginId 确认当前尝试。 */
export function createCodexMcpRoutes(socketPath, ownerSignal) {
  const attempts = new Map()
  ownerSignal?.addEventListener('abort', () => attempts.clear(), { once: true })

  async function login(name, threadId, requestSignal) {
    requestSignal.throwIfAborted()
    const attemptId = randomUUID()
    const timeout = AbortSignal.timeout((loginTimeoutSecs + 5) * 1000)
    const signal = ownerSignal ? AbortSignal.any([timeout, ownerSignal]) : timeout
    let loginId
    let result
    let close
    const early = new Map()
    function complete(notification) {
      result.status = notification.success ? { state: 'success' } : { state: 'failed', error: notification.error }
      close()
    }
    const connection = await openCodexReader(socketPath, signal, ({ method, params }) => {
      if (method !== 'mcpServer/oauthLogin/completed' || params?.name !== name
        || (params.threadId ?? undefined) !== threadId || !params.loginId) return
      if (params.loginId === loginId) complete(params)
      else if (!loginId) early.set(params.loginId, params)
    })
    close = connection.close
    try {
      const response = await connection.request('mcpServer/oauth/login', { name, threadId, timeoutSecs: loginTimeoutSecs })
      const authorizationUrl = externalWebUrl(response.authorizationUrl)
      if (!authorizationUrl) throw invalidCapabilityRequest('Codex 未返回有效的 OAuth 授权地址。')
      loginId = response.loginId
      if (!loginId) {
        close()
        return { authorizationUrl }
      }
      result = { status: { state: 'pending' } }
      attempts.set(attemptId, result)
      if (early.has(loginId)) complete(early.get(loginId))
      early.clear()
      void connection.closed.then(() => {
        if (result.status.state === 'pending') result.status = { state: 'unknown' }
        const expire = setTimeout(() => attempts.delete(attemptId), (loginTimeoutSecs + 5) * 1000)
        expire.unref()
      })
      return { authorizationUrl, attemptId }
    } catch (error) {
      close()
      throw error
    }
  }

  const read = ({ threadId, name }, signal) => withCodexReader(socketPath, signal, async request => ({
    servers: await readCodexPages(cursor => request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly', threadId: threadId || undefined, serverName: name || undefined, cursor,
    })),
  }))
  const change = ({ action, name, threadId }, signal) => {
    if (action === 'reload') return readCodex('config/mcpServer/reload', null, socketPath, signal)
    if (action === 'login' && requiredValue(name) && (threadId === undefined || requiredValue(threadId))) {
      return login(name, threadId, signal)
    }
    throw invalidCapabilityRequest('Codex MCP 操作无效。')
  }
  return [createCodexCapabilityRoute('mcp', ownerSignal, read, change),
    createCodexCapabilityRoute('mcp-login', ownerSignal, ({ attemptId }) => attempts.get(attemptId)?.status ?? { state: 'unknown' })]
}
