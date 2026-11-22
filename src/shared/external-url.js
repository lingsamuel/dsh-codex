/** Codex 返回的网页跳转地址使用 HTTP(S)，不携带 URL 用户名或密码。 */
export function externalWebUrl(value) {
  if (typeof value !== 'string') return
  try {
    const url = new URL(value)
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch {}
}
