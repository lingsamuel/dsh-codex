import assert from 'node:assert/strict'
import test from 'node:test'

function searchFixture(t, pages) {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = originalDocument })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.pathname, '/api/codex/search')
    assert.equal(url.searchParams.get('searchTerm'), 'word')
    assert.ok(options.signal instanceof AbortSignal)
    const archived = url.searchParams.get('archived') === '1'
    requests.push(archived)
    return Response.json(pages[archived ? 'archived' : 'active'])
  })
  return requests
}

const hit = (id, updatedAt) => ({ thread: { id, updatedAt }, snippet: id })

test('按侧栏筛选查询原生正文并为归档命中保留状态', async t => {
  const { searchCodexThreads } = await import('../src/client/thread-search.js')
  const active = { data: [hit('active', 9)], workspacePaths: { '/active': '/Active' } }
  const archived = { data: [hit('archived', 11)], workspacePaths: { '/archive': '/Archive' }, nextCursor: 'later' }
  const requests = searchFixture(t, { active, archived })
  const signal = new AbortController().signal
  const ordinary = await searchCodexThreads('word', signal, 'default')
  const archivedOnly = await searchCodexThreads('word', signal, 'only')
  assert.deepEqual(requests, [false, true])
  assert.deepEqual(ordinary.data.map(item => item.thread), [active.data[0].thread])
  assert.deepEqual(archivedOnly.data.map(item => item.thread), [{ ...archived.data[0].thread, archived: true }])
  assert.equal(archivedOnly.hasMore, true)
})

test('同时搜索两组结果时保持最近顺序、去重和已有结果上限', async t => {
  const { searchCodexThreads, searchResultLimit } = await import('../src/client/thread-search.js')
  const active = { data: Array.from({ length: searchResultLimit }, (_, i) => hit(`active-${i}`, 80 - i)), workspacePaths: { '/active': '/Active' } }
  const archived = { data: [hit('archived', 90), hit('active-0', 78)], workspacePaths: { '/archive': '/Archive' } }
  const requests = searchFixture(t, { active, archived })
  const result = await searchCodexThreads('word', new AbortController().signal, 'show')
  assert.deepEqual(requests, [false, true])
  assert.equal(result.data.length, searchResultLimit)
  assert.deepEqual(result.data.slice(0, 3).map(item => item.thread.id), ['archived', 'active-0', 'active-1'])
  assert.equal(new Set(result.data.map(item => item.thread.id)).size, searchResultLimit)
  assert.deepEqual(result.workspacePaths, { '/active': '/Active', '/archive': '/Archive' })
  assert.equal(result.hasMore, true)
})
