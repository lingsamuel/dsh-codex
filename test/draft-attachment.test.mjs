import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { createFileUploads } from '../src/host/file-uploads.mjs'
import { createHistoryRoutes } from '../src/host/history.mjs'
import { fileAttachmentOf } from '../src/shared/file-attachments.js'
import { createLocalAttachmentStore } from './support/dsh-attachments.mjs'

async function attachmentProfile(t, nativeThreadId) {
  const runtime = join(process.cwd(), '.runtime')
  await mkdir(runtime, { recursive: true })
  const directory = await mkdtemp(join(runtime, 'draft-files-'))
  const socketPath = join(directory, 'api.sock')
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const calls = []
  let connections = 0
  sockets.on('connection', socket => {
    connections++
    socket.on('message', message => {
      const { id, method, params } = JSON.parse(message)
      if (id === undefined) return
      calls.push({ method, params })
      let reply
      if (method === 'initialize') reply = { result: { userAgent: 'test Codex', codexHome: directory } }
      else if (method === 'thread/read' && params.threadId === nativeThreadId) {
        reply = { result: { thread: { id: params.threadId, status: { type: 'idle' } } } }
      } else reply = { error: { code: -32600, message: '会话不可用' } }
      socket.send(JSON.stringify({ id, ...reply }))
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const owner = new AbortController()
  t.after(async () => {
    owner.abort()
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })

  const storage = await createLocalAttachmentStore(join(directory, 'dsh'))
  const files = createFileUploads(storage, socketPath, owner.signal)
  async function upload(sessionId, name, body) {
    const url = new URL(files.upload.path, 'http://localhost')
    url.search = new URLSearchParams({ sessionId, name })
    const response = await files.upload.fetch(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    }))
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true, result.error?.message)
    return result.value
  }

  return {
    upload, resolve: files.resolve, calls, connections: () => connections,
    routes: () => createHistoryRoutes(socketPath, owner.signal, join(directory, 'profile'), storage),
  }
}

test('新会话可在连接 Codex 前上传文件，且回执绑定该会话', async t => {
  const host = await attachmentProfile(t)
  const localId = `web-new-${randomUUID()}`
  const body = Buffer.from('未发送会话的文件')
  const { receiptId, file } = await host.upload(localId, '报告 空格.txt', body)

  assert.equal(host.connections(), 0)
  assert.equal(file.name, '报告 空格.txt')
  assert.equal(file.bytes, body.length)
  assert.deepEqual(fileAttachmentOf(host.resolve(localId, receiptId)), file)
  assert.equal(host.resolve(`web-new-${randomUUID()}`, receiptId), undefined)
  assert.equal(host.resolve('native-thread', receiptId), undefined)
})

test('原生会话上传验证线程，且回执绑定该线程', async t => {
  const threadId = 'native-thread'
  const host = await attachmentProfile(t, threadId)
  const { receiptId, file } = await host.upload(threadId, '报告.txt', '已有会话的文件')

  assert.equal(host.connections(), 1)
  assert.deepEqual(host.calls.filter(call => call.method === 'thread/read'), [
    { method: 'thread/read', params: { threadId } },
  ])
  assert.deepEqual(fileAttachmentOf(host.resolve(threadId, receiptId)), file)
  assert.equal(host.resolve('another-thread', receiptId), undefined)
  assert.equal(host.resolve(`web-new-${randomUUID()}`, receiptId), undefined)
})

test('主机保留普通文件上传和下载入口，撤下旧草稿入口', async t => {
  const routes = (await attachmentProfile(t)).routes()
  const registered = (path, method) => routes.some(route => route.path === path && route.methods.includes(method))

  assert.equal(registered('/api/session/uploadFileBinary', 'POST'), true)
  assert.equal(registered('/api/codex/file-download', 'GET'), true)
  assert.equal(registered('/api/codex/drafts', 'GET'), false)
  assert.equal(registered('/api/codex/drafts', 'POST'), false)
  assert.equal(registered('/api/codex/draft-file', 'GET'), false)
  assert.equal(registered('/api/codex/draft-attachment', 'GET'), false)
})
