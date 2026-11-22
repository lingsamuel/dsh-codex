import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileReferenceRoute } from '../src/host/file-references.mjs'

test('文件补全以原生会话的工作目录为准，并将含空格的路径原样交给 DSH', async () => {
  const lookups = []
  const roots = []
  const queries = []
  const owner = new AbortController()
  try {
    const route = createFileReferenceRoute(async threadId => {
      lookups.push(threadId)
      return { workspaceRoot: '/native/workspace' }
    }, cwd => {
      roots.push(cwd)
      return {
        list(query) {
          queries.push(query)
          return [{ path: `${query}.md`, kind: 'file' }]
        },
        dispose() {},
      }
    }, owner.signal)
    const query = (text, candidateRoot) => route.fetch(new Request(`http://local${route.path}?${new URLSearchParams({
      threadId: 'native-thread', query: text, cwd: candidateRoot,
    })}`))
    const response = await query('doc/file with spaces', '/outside')
    assert.deepEqual(await response.json(), [{ path: 'doc/file with spaces.md', kind: 'file' }])
    await query('another', '/other')
    assert.deepEqual(lookups, ['native-thread', 'native-thread'])
    assert.deepEqual(roots, ['/native/workspace'])
    assert.deepEqual(queries, ['doc/file with spaces', 'another'])
  } finally {
    owner.abort()
  }
})

test('DSH 目录补全保留可深入的草稿路径，发送时闭合含空格路径的引号', async () => {
  const { installFileReferences } = await import('../src/client/native-dsh/file-references.js')
  const files = {}
  const sessions = {}
  const normal = async (_source, ref) => ref
  const inputTriggers = { serializeReference: normal }
  const services = { 'remote.fileReferences': files, 'remote.sessionReferenceResolver': sessions, inputTriggers }
  const cleanup = []
  installFileReferences({
    inject(_keys, apply) {
      apply({ inputTriggers, get: key => services[key], effect: effect => cleanup.push(effect()) })
    },
  })
  try {
    assert.equal(await inputTriggers.serializeReference('reference', '@"docs/source folder/'), '@"docs/source folder/"')
    assert.equal(await inputTriggers.serializeReference('reference', '@"docs/file with spaces.md"'), '@"docs/file with spaces.md"')
    assert.equal(await inputTriggers.serializeReference('reference', '@docs/'), '@docs/')
    assert.equal(await inputTriggers.serializeReference('other', '@"docs/source folder/'), '@"docs/source folder/')
  } finally {
    for (const dispose of cleanup.reverse()) dispose()
  }
  assert.equal(inputTriggers.serializeReference, normal)
})
