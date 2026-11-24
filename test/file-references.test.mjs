import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { createFileReferenceRoute } from '../src/host/file-references.mjs'
import { resolveWorkspaceFileScope } from '../src/host/workspace-paths.mjs'

const runtime = join(process.cwd(), '.runtime')
before(() => mkdir(runtime, { recursive: true }))

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

test('本地草稿从已选工作目录取得路径候选，无需查找原生线程', async t => {
  const cwd = await mkdtemp(join(runtime, 'draft-references-'))
  const owner = new AbortController()
  t.after(async () => {
    owner.abort()
    await rm(cwd, { recursive: true, force: true })
  })
  const roots = []
  const route = createFileReferenceRoute(() => assert.fail('草稿没有原生线程'), root => {
    roots.push(root)
    return { list: query => [{ path: `${query}.md`, kind: 'file' }], dispose() {} }
  }, owner.signal)
  const get = root => route.fetch(new Request(`http://local${route.path}?${new URLSearchParams({ cwd: root, query: 'notes' })}`))
  assert.deepEqual(await (await get(cwd)).json(), [{ path: 'notes.md', kind: 'file' }])
  assert.equal((await get('relative/path')).status, 400)
  assert.deepEqual(roots, [cwd])
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

test('DSH 草稿 @ 补全随编辑器的工作目录切换，原生会话仍按 ID 查询', async t => {
  const { installFileReferences } = await import('../src/client/native-dsh/file-references.js')
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  const files = {}
  const services = { 'remote.fileReferences': files, 'remote.sessionReferenceResolver': {} }
  let cwd = '/one'
  const draft = 'draft-local'
  const sessions = {
    binding: id => ({ session: { getSnapshot: () => ({ localDraft: id === draft }) } }),
    list: { getSnapshot: () => ({ byId: { [draft]: { cwd } } }) },
  }
  installFileReferences({ inject(keys, apply) {
    if (!keys.includes('remote.fileReferences')) return
    apply({ sessions, get: key => services[key], effect: effect => t.after(effect()) })
  } })
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(Object.fromEntries(url.searchParams))
    return Response.json([{ path: 'notes.md', kind: 'file' }])
  })
  assert.equal((await files.list(draft, 'notes')).ok, true)
  cwd = '/two'
  assert.equal((await files.list(draft, 'notes')).ok, true)
  assert.equal((await files.list('native', 'notes')).ok, true)
  assert.deepEqual(calls, [
    { cwd: '/one', query: 'notes' }, { cwd: '/two', query: 'notes' }, { threadId: 'native', query: 'notes' },
  ])
})

test('已有目录里的标题候选无需发出搜索请求，缺少标题才请求 Host', async t => {
  const { installFileReferences } = await import('../src/client/native-dsh/file-references.js')
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  const sessionReferences = {}
  const services = { 'remote.fileReferences': {}, 'remote.sessionReferenceResolver': sessionReferences }
  const catalog = { getSnapshot: () => ({ threads: [
    { id: 'current', name: 'MCP 当前', cwd: '/repo', createdAt: 1 },
    { id: 'nearby', name: 'MCP 续接', cwd: '/repo/sub', createdAt: 2 },
    { id: 'preview-only', name: '另一个标题', preview: 'MCP 正文', cwd: '/repo', createdAt: 3 },
  ], workspacePaths: {} }) }
  installFileReferences({ inject(keys, apply) {
    if (!keys.includes('remote.fileReferences')) return
    apply({ sessions: { binding: () => undefined }, get: key => services[key], effect: effect => t.after(effect()) })
  } }, catalog)
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push([url.pathname, Object.fromEntries(url.searchParams)])
    return Response.json([])
  })

  const local = await sessionReferences.candidates('current', 'mcp')
  assert.deepEqual(local.value.map(({ sessionId, sameWorkspace }) => [sessionId, sameWorkspace]), [['nearby', true]])
  assert.deepEqual(calls, [])
  assert.deepEqual((await sessionReferences.candidates('current', '远处标题')).value, [])
  assert.deepEqual(calls, [['/api/codex/thread-references', { threadId: 'current', query: '远处标题' }]])
})

test('Codex 文件视图标记会话来源并在退出后恢复原生远程调用', async () => {
  const { installCodexFileScope } = await import('../src/client/native-dsh/dual-workspace-files.js')
  const calls = []
  const provider = { stat(id, path, signal) {
    assert.equal(this, provider)
    calls.push([id, path, signal])
    return { exists: true }
  } }
  const original = provider.stat
  let dispose
  installCodexFileScope({ inject(keys, apply) {
    assert.ok(keys.includes('remote.workspaceFiles'))
    apply({ remote: { workspaceFiles: provider }, sessions: {}, effect: effect => { dispose = effect() } })
  } })
  const signal = new AbortController().signal
  assert.deepEqual(await provider.stat('thread', 'notes.md', signal), { exists: true })
  assert.deepEqual(calls, [['codex:thread', 'notes.md', signal]])
  dispose()
  assert.equal(provider.stat, original)
  provider.stat('native-session', 'notes.md', signal)
  assert.deepEqual(calls.at(-1), ['native-session', 'notes.md', signal])
})

test('双入口和独立实例的 Files 都用网页草稿的目录打开列表和监听', async t => {
  const { installCodexFileScope } = await import('../src/client/native-dsh/dual-workspace-files.js')
  const draft = 'web-new-5b8d04ea-3657-422f-9479-39d7dd5c4108'
  const cwd = await mkdtemp(join(runtime, process.platform === 'win32' ? 'work space ' : 'work space: '))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const signal = new AbortController().signal
  const sessions = { list: { getSnapshot: () => ({ byId: { [draft]: { cwd } } }) } }

  for (const [sharedWeb, prefix] of [[true, 'codex:'], [false, '']]) {
    const provider = {
      changes: (...args) => args,
      list: (...args) => args,
    }
    installCodexFileScope({ inject(_keys, apply) {
      apply({ remote: { workspaceFiles: provider }, sessions, effect: effect => effect() })
    } }, sharedWeb)
    for (const name of ['changes', 'list']) {
      const [id, path, cancellation] = provider[name](draft, '.', signal)
      assert.ok(id.startsWith(prefix))
      const files = await resolveWorkspaceFileScope(id.slice(prefix.length), () => assert.fail('草稿没有原生线程'))
      assert.deepEqual(files, { sessionId: draft, workspaceRoot: cwd })
      assert.equal(path, '.')
      assert.equal(cancellation, signal)
    }
    assert.deepEqual(provider.list('thread', '.', signal), [`${prefix}thread`, '.', signal])
  }
})

test('文件作用域拒绝失效的草稿目录，并按原 ID 查询正式线程', async t => {
  const base = await mkdtemp(join(runtime, 'draft-file-scope-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const draft = 'web-new-5b8d04ea-3657-422f-9479-39d7dd5c4108'
  const readDraft = id => resolveWorkspaceFileScope(id, () => assert.fail('草稿没有原生线程'))
  const file = join(base, 'notes.md')
  await writeFile(file, 'test')
  for (const id of [draft, `${draft}:relative`, `${draft}:${file}`, `${draft}:${join(base, 'missing')}`]) {
    assert.equal(await readDraft(id), undefined)
  }
  const thread = 'urn:uuid:5b8d04ea-3657-422f-9479-39d7dd5c4108'
  assert.deepEqual(await resolveWorkspaceFileScope(thread, id => {
    assert.equal(id, thread)
    return base
  }), { sessionId: thread, workspaceRoot: base })
})
