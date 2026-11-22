import assert from 'node:assert/strict'
import test from 'node:test'
import { readInlineCodexAttachments } from '../src/client/native-chat/attachments.js'
import { projectCodexTurns } from '../src/client/native-chat/events.js'

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
