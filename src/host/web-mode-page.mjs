import { randomUUID } from 'node:crypto'
import { webModeNotice, webModePath } from '../shared/web-mode.js'

/** 过渡页先卸载会话 UI，避免页面在 Host 重组期间继续操作旧模式。 */
export function webModePage(patch, requested) {
  const nonce = randomUUID()
  const recovery = patch === undefined
  const input = JSON.stringify(patch ?? null).replaceAll('<', '\\u003c')
  const endpoint = requested === 'dsh' || requested === 'codex' ? `./web-mode?mode=${requested}` : './web-mode'
  const content = recovery
    ? `<p>Web 模式未完成切换。<br>Web mode needs recovery.</p>
       <p role="status" id="notice"></p>
       <form method="post" action="./web-mode"><button name="restore" value="true">恢复 DSH · Restore DSH</button></form>
       <script type="module" nonce="${nonce}">
       document.getElementById('notice').textContent = sessionStorage.getItem(${JSON.stringify(webModeNotice)}) ?? ''
       </script>`
    : `<p role="status">正在切换 Web 模式…<br>Switching Web mode…</p>
       <script type="module" nonce="${nonce}">
       const notice = ${JSON.stringify(webModeNotice)}
       let result, error
       try {
         const response = await fetch(${JSON.stringify(endpoint)}, { method: 'POST',
           headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${input}) })
         result = await response.json()
         error = result.error
       } catch (failure) {
         error = failure.message
       }
       try {
         if (error) sessionStorage.setItem(notice, error)
         else sessionStorage.removeItem(notice)
         const updates = new BroadcastChannel('dsh-chatgpt:web-mode:' + ${JSON.stringify(webModePath)})
         updates.postMessage(null)
         updates.close()
       } catch {}
       location.replace(result?.mode === 'recovery' ? './web-mode?recovery' :
         result?.mode ? '../../?mode=' + result.mode : '../../')
       </script>`

  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>DSH Web</title><main>${content}</main><a href="../../">返回 Web · Return to Web</a>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'` },
  })
}
