import { CodexRpcError } from './app-server.mjs'

export const requiredValue = value => typeof value === 'string' && Boolean(value.trim())

export function invalidCapabilityRequest(message) {
  return new CodexRpcError({ code: -32602, message })
}

/** 使用 DSH 已保护的同源路由；目录和授权结果均不进入 HTTP 缓存。 */
export function createCodexCapabilityRoute(path, ownerSignal, get, post) {
  return {
    path: `/api/codex/${path}`,
    methods: post ? ['GET', 'POST'] : ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      try {
        if (request.method === 'GET') return json(await get(Object.fromEntries(new URL(request.url).searchParams), signal))
        const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') return json({ error: '只接受 JSON 请求。' }, 415)
        const body = await request.json().catch(() => null)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidCapabilityRequest('请求格式无效。')
        return json(await post(body, signal))
      } catch (error) {
        if (error instanceof CodexRpcError) {
          return json({ error: error.message }, error.code === -32602 ? 400 : 502)
        }
        return json({ error: '无法读取或更新 Codex 状态。请检查共享 App Server 是否正在运行。' }, 503)
      }
    },
  }
}
