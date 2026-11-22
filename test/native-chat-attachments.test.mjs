import assert from 'node:assert/strict'
import test from 'node:test'
import { readInlineCodexAttachments } from '../src/client/native-chat/attachments.js'
import { projectCodexTurns } from '../src/client/native-chat/events.js'
import { fileAttachmentInput } from '../src/shared/file-attachments.js'
import { replaceUserInputText, userInputText } from '../src/shared/user-input.js'

test('a stored file appears as a downloadable attachment in the originating history item', () => {
  const file = { attachmentId: 'sha256:' + 'a'.repeat(64), name: '报告.txt', bytes: 13 }
  const path = '/store/报告.txt'
  const input = fileAttachmentInput(file, path)
  const content = [{ type: 'text', text: '查看附件' }, input, { type: 'text', text: '@"/工作区/其他.txt"' }]
  const turns = [{ id: 'turn', items: [{ id: 'item', type: 'userMessage', content }] }]
  const { event } = projectCodexTurns(turns, { fileThreadId: 'thread' }).find(({ event }) => event.type === 'user/message')
  assert.deepEqual(event.data.content, [
    { type: 'text', text: '查看附件' },
    { type: 'file', attachment: { ...file, downloadUrl: 'api/codex/file-download?' + new URLSearchParams({
      threadId: 'thread', turnId: 'turn', itemId: 'item', attachmentId: file.attachmentId, name: file.name,
    }) } },
    { type: 'text', text: '@"/工作区/其他.txt"' },
  ])
})

test('legacy history may join text and attachment spans into one UTF-8 buffer', () => {
  const file = { attachmentId: 'sha256:' + 'b'.repeat(64), name: '📄 报告.txt', bytes: 8 }
  const report = fileAttachmentInput(file, '/files/📄 报告.txt')
  const other = fileAttachmentInput({ ...file, name: 'alias.txt' }, '/files/alias.txt')
  const before = '替换正文📍'
  const between = '与'
  const offset = Buffer.byteLength(before)
  const lastOffset = Buffer.byteLength(before + report.text + between)
  const input = { type: 'text', text: before + report.text + between + other.text, text_elements: [
    { ...report.text_elements[0], byteRange: { start: offset, end: offset + Buffer.byteLength(report.text) } },
    { ...other.text_elements[0], byteRange: { start: lastOffset, end: lastOffset + Buffer.byteLength(other.text) } },
  ] }
  assert.equal(userInputText([input]), before + between)
  assert.deepEqual(replaceUserInputText([input], '新正文'), [
    { type: 'text', text: '新正文', text_elements: [] }, report, other,
  ])
  const turns = [{ id: 'turn', items: [{ id: 'item', type: 'userMessage', content: [input] }] }]
  const { event } = projectCodexTurns(turns).find(({ event }) => event.type === 'user/message')
  assert.deepEqual(event.data.content, [
    { type: 'text', text: before }, { type: 'file', attachment: file },
    { type: 'text', text: between }, { type: 'file', attachment: { ...file, name: 'alias.txt' } },
  ])
})

test('inline images back DSH attachments with the native bytes and leave other attachment types alone', async t => {
  const source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  const originalImage = globalThis.Image
  globalThis.Image = class {
    naturalWidth = 1
    naturalHeight = 1
    async decode() { assert.equal(this.src, source) }
  }
  t.after(() => { globalThis.Image = originalImage })

  const turns = [{ id: 'turn', items: [{ id: 'ask', type: 'userMessage', content: [
    { type: 'text', text: 'look' },
    { type: 'image', url: source },
    { type: 'localImage', path: '/unread.png' },
    { type: 'image', url: 'https://example.invalid/unread.png' },
    { type: 'image', url: 'data:image/png;base64,!' },
  ] }] }]
  const attachments = await readInlineCodexAttachments(turns)
  assert.equal(attachments.size, 1)
  const [{ attachment, data }] = attachments.values()
  assert.deepEqual(attachment, {
    attachmentId: 'codex:ask:1', mediaType: 'image/png', bytes: 70, width: 1, height: 1,
  })
  assert.deepEqual(data, new Uint8Array(Buffer.from(source.split(',')[1], 'base64')))
  const message = projectCodexTurns(turns, { attachments }).find(({ event }) => event.type === 'user/message')
  assert.deepEqual(message.event.data.content, [
    { type: 'text', text: 'look' },
    { type: 'image', attachment },
    { type: 'text', text: '/unread.png' },
    { type: 'text', text: '图片附件' },
    { type: 'text', text: '图片附件' },
  ])
})
