import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { sep } from 'node:path'
import { Readable } from 'node:stream'
import { codexSqliteHome, CodexRpcError, openCodexReader, readCodexPages, withCodexReader } from './app-server.mjs'
import { addressableThread } from './thread-runtime.mjs'
import { readThreadTurns } from './live-history.mjs'
import { readVisibleConversationQueue } from './queue-watch.mjs'
import { fileAttachmentInput, fileAttachmentOf, splitFileAttachmentInput } from '../shared/file-attachments.js'
import { isLocalSessionId } from '../shared/local-session.js'
import { codexFileUploadPath } from '../shared/upload-path.js'

const noCache = { 'Cache-Control': 'no-store' }

/** 复用 DSH 的流式上传协议，把原生附件仓库的回执绑定到当前会话 ID。 */
export function createFileUploads(attachments, socketPath, ownerSignal, steers) {
  const key = randomBytes(32)
  const sign = (threadId, payload) => createHmac('sha256', key).update(JSON.stringify([threadId, payload])).digest('base64url')
  const lifetime = request => ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
  const filePath = file => attachments.fileHostPath(file)
  const input = file => {
    const path = filePath(file)
    return fileAttachmentInput(file, sep === '\\' ? path.replaceAll('\\', '/') : path)
  }

  function verifiedFile(threadId, receiptId) {
    if (typeof receiptId !== 'string') return
    const [payload, signature, extra] = receiptId.split('.')
    if (!payload || !signature || extra !== undefined) return
    const received = Buffer.from(signature)
    const expected = Buffer.from(sign(threadId, payload))
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  }

  function resolve(threadId, receiptId) {
    const file = verifiedFile(threadId, receiptId)
    return file && input(file)
  }

  const upload = {
    path: codexFileUploadPath, methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/octet-stream') return new Response(null, { status: 415 })
      const query = new URL(request.url).searchParams
      const threadId = query.get('sessionId')
      if (!threadId || query.has('mediaType')) return new Response(null, { status: 400 })
      const signal = lifetime(request)
      try {
        if (!isLocalSessionId(threadId)) await withCodexReader(socketPath, signal, rpc => addressableThread(rpc, threadId, true))
        const file = await attachments.saveFileStream({ data: request.body ?? [], name: query.get('name') ?? undefined, signal })
        const payload = Buffer.from(JSON.stringify(file)).toString('base64url')
        return Response.json({ ok: true, value: { file, receiptId: [payload, sign(threadId, payload)].join('.') } }, { headers: noCache })
      } catch (error) {
        const message = error instanceof CodexRpcError ? error.message : '无法保存上传的文件。'
        return Response.json({ ok: false, error: { code: 'gateway/internal', message, details: {} } }, { headers: noCache })
      }
    },
  }

  async function readInput(rpc, threadId, query, codexHome, signal) {
    const queuedSubmissionId = query.get('queuedSubmissionId')
    if (queuedSubmissionId) {
      const pending = steers?.find(threadId, queuedSubmissionId)
      if (pending) return pending.item.input
      const queue = await readVisibleConversationQueue(rpc, threadId, async () =>
        codexSqliteHome(await rpc('config/read', { includeLayers: false }).catch(() => null), codexHome), signal)
      return queue.find(item => item.id === queuedSubmissionId)?.input
    }
    const turnId = query.get('turnId')
    const itemId = query.get('itemId')
    let items
    try {
      const rows = await readCodexPages(cursor => rpc('thread/items/list', {
        threadId, turnId, limit: 100, ...(cursor != null && { cursor }),
      }))
      items = rows.map(({ item }) => item)
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== -32601) throw error
      // 旧格式的会话只能通过轮次分页读取正文。
      const [turn] = await readCodexPages(async cursor => {
        const page = await readThreadTurns(rpc, { threadId, limit: 25, sortDirection: 'desc', itemsView: 'full',
          ...(cursor != null && { cursor }) })
        const match = page.data.find(turn => turn.id === turnId)
        return match ? { data: [match] } : { data: [], nextCursor: page.nextCursor }
      })
      items = turn?.items ?? []
    }
    return items.find(item => item.type === 'userMessage' && item.id === itemId)?.content
  }

  async function readDownloadInput(threadId, query, signal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const connection = await openCodexReader(socketPath, deadline)
    try {
      return await readInput(connection.request, threadId, query, connection.initialize.codexHome, deadline)
    } finally {
      connection.close()
    }
  }

  const download = {
    path: '/api/codex/file-download', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams
      const threadId = query.get('threadId')
      const attachmentId = query.get('attachmentId')
      const name = query.get('name')
      if (!threadId || !attachmentId || !name
        || (!query.get('queuedSubmissionId') && !(query.get('turnId') && query.get('itemId')))) {
        return new Response(null, { status: 400, headers: noCache })
      }
      const signal = lifetime(request)
      try {
        const content = await readDownloadInput(threadId, query, signal)
        // 用内容身份匹配文件。另一客户端编辑正文时可能改变附件在消息中的位置。
        const file = content?.flatMap(splitFileAttachmentInput).flatMap(part => {
          const ref = fileAttachmentOf(part)
          return ref?.attachmentId === attachmentId && ref.name === name && input(ref).text === part.text ? [ref] : []
        })[0]
        if (!file || !(await stat(filePath(file))).isFile()) {
          return new Response(null, { status: 404, headers: noCache })
        }
        const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16))
        return new Response(Readable.toWeb(Readable.from(attachments.readFileStream(file, signal), { objectMode: false })), {
          headers: { ...noCache, 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodedName,
            'X-Content-Type-Options': 'nosniff' },
        })
      } catch (error) {
        const missing = error.code === 'ENOENT' || error instanceof CodexRpcError && [-32600, -32602].includes(error.code)
        return new Response(null, { status: missing ? 404 : 502, headers: noCache })
      }
    },
  }

  return { upload, download, resolve }
}
