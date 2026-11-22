import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeThreadReference, prepareThreadReferences, displayThreadReferenceText, threadReferencesIn } from '../src/shared/thread-references.js'
import { codexTaskToolsConfig, codexTaskToolsServerName, hasThreadReadTool } from '../src/host/codex-task-tools-config.mjs'

test('会话引用保留 Codex 线程 ID、可见标题和 UTF-8 文本范围', () => {
  const first = encodeThreadReference('thread-a', '修复 [图片] \\预览')
  const second = encodeThreadReference('thread-b', '另一个会话')
  const visible = `参照 ${first} 和 ${second}，再比对 ${first}`
  const parts = [{ type: 'text', text: visible, text_elements: [] }, { type: 'image', url: 'test-image' }]
  const encoded = prepareThreadReferences(parts, 'current-thread')
  const text = encoded[0].text
  assert.match(text, /"threadId":"thread-a"/)
  assert.match(text, /"threadId":"thread-b"/)
  assert.equal(text.match(/"threadId":"thread-a"/g)?.length, 1)
  assert.deepEqual(encoded[0].text_elements.map(({ byteRange }) =>
    Buffer.from(text).subarray(byteRange.start, byteRange.end).toString()),
  [first, second, first])
  assert.equal(displayThreadReferenceText(text), visible)
  assert.deepEqual(prepareThreadReferences(encoded, 'current-thread'), encoded)
  assert.equal(encoded[1], parts[1])
})

test('线程级 MCP 接线沿用原版三项委派工具审批', async () => {
  const config = codexTaskToolsConfig('/run/user/codex.sock')
  const server = config[`mcp_servers.${codexTaskToolsServerName}`]
  assert.equal(server.args.at(-1), '/run/user/codex.sock')
  assert.deepEqual(server.tools, {
    create_thread: { approval_mode: 'prompt' },
    send_message_to_thread: { approval_mode: 'prompt' },
    fork_thread: { approval_mode: 'prompt' },
  })
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    return { data: params.serverName === 'codex_tui'
      ? [{ name: 'codex_tui', runtimeStatus: 'connected', tools: { read_thread: {} } }]
      : [] }
  }
  assert.equal(await hasThreadReadTool(request, 'original'), true)
  assert(calls.every(([method, params]) => method === 'mcpServerStatus/list' && params.threadId === 'original'))
  assert.equal(await hasThreadReadTool(async () => ({
    data: [{ runtimeStatus: 'failed', tools: { read_thread: {} } }],
  }), 'original'), false)
})

test('引用匹配不会吞掉相邻文字，标题与转义前缀均可往返', () => {
  const title = '任务 [@测试] \\继续'
  const reference = encodeThreadReference('task-a', title)
  const prefix = '参照 [@示例文字 '
  const [match] = threadReferencesIn(prefix + reference)
  assert.deepEqual(match, { threadId: 'task-a', title, start: prefix.length, end: prefix.length + reference.length })
  assert.deepEqual(threadReferencesIn('\\' + reference), [])
  assert.equal(threadReferencesIn('\\\\' + reference)[0].start, 2)
})
