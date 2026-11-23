import { FileUploadRuntime } from '@deepseek-ai/dsh-client-file-upload/src/client/runtime.ts'
import { FILE_UPLOAD_ROUTE } from '@deepseek-ai/dsh-client-file-upload/src/protocol.ts'
import { codexFileUploadRoute } from '../../shared/upload-path.js'

/** 原生组件继续负责传输与回执解析，用独立路由把附件交给 Codex 会话。 */
export class CodexFileUploadRuntime extends FileUploadRuntime {
  upload(sessionId, data, ...options) {
    // 原生精确字节走 DSH 的会话 RPC，转换为 Blob 后可使用同一条 Codex 流式路由。
    return super.upload(sessionId, data instanceof Uint8Array ? new Blob([data]) : data, ...options)
  }

  post(request) {
    const original = `${FILE_UPLOAD_ROUTE}?`
    const path = request.path.startsWith(original)
      ? `${codexFileUploadRoute}?${request.path.slice(original.length)}` : request.path
    return super.post({ ...request, path })
  }
}
