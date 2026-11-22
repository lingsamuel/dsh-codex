import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCatalog } from '../src/client/native-dsh/catalog.js'
import { readCatalogEvent } from '../src/host/catalog-events.mjs'

test('projects native workspace membership and timestamps into DSH sidebar rows', () => {
  const first = {
    id: 'native-thread', projectId: 'native-project', name: 'Native title',
    cwd: '/wsl/worktree', createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
  }
  const second = { id: 'other-thread', cwd: '/worktree/alias', preview: 'Preview', updatedAt: 1_700_000_080 }
  const state = {
    projects: [{
      id: 'native-project', name: 'Native project',
      roots: [{ path: '/repo/primary' }, { path: '/repo/additional' }],
      createdAt: 1_699_999_999, updatedAt: 1_700_000_110,
    }],
    threads: [first, second],
    selected: first,
    workspacePaths: { '/wsl/worktree': '/repo/inferred', '/worktree/alias': '/repo/primary' },
    busy: false,
    error: '',
  }

  const { sessions, workspaces } = projectCatalog(state)
  assert.deepEqual(sessions.ids, [first.id, second.id])
  assert.equal(sessions.byId[first.id].cwd, first.cwd)
  assert.equal(sessions.byId[first.id].displayTitle, first.name)
  assert.equal(sessions.byId[first.id].updatedAt, first.updatedAt * 1000)
  assert.deepEqual(sessions.byId[first.id].retainedBy, { mainView: 1 })
  assert.deepEqual(sessions.byId[second.id].retainedBy, {})
  const native = workspaces.items.find(workspace => workspace.workspaceId === 'project:native-project')
  assert.equal(native.path, '/repo/primary')
  assert.equal(native.title, 'Native project')
  assert.ok(native.sessionIds.includes(first.id))
  assert.equal(native.createdAt, new Date(state.projects[0].createdAt * 1000).toISOString())
  assert.equal(native.updatedAt, new Date(state.projects[0].updatedAt * 1000).toISOString())
  const inferred = workspaces.items.find(workspace => workspace.sessionIds.includes(second.id))
  assert.equal(inferred.updatedAt, new Date(second.updatedAt * 1000).toISOString())
})

test('目录工作区按最新未归档对话排序，独立于会话清单的顺序', () => {
  const projects = [
    { id: 'first', roots: [{ path: '/first-project' }], updatedAt: 100 },
    { id: 'second', roots: [{ path: '/second-project' }], updatedAt: 300 },
  ]
  const opened = { id: 'opened', cwd: '/alpha', updatedAt: 100 }
  const threads = [
    { id: 'zeta', cwd: '/zeta', updatedAt: 200 },
    opened,
    { id: 'beta-old', cwd: '/beta', updatedAt: 50 },
    { id: 'beta-new', cwd: '/beta', updatedAt: 200 },
    { id: 'alpha-archive', cwd: '/alpha', updatedAt: 400, archived: true },
    { id: 'only-archive', cwd: '/archive', updatedAt: 500, archived: true },
  ]
  const expected = ['/first-project', '/second-project', '/beta', '/zeta', '/alpha', '/archive']
  const startup = projectCatalog({ projects, threads })
  assert.deepEqual(startup.workspaces.items.map(item => item.path), expected)

  // 打开现有会话时，读回摘要会触发目录清单按原生会话时间重排。
  const refreshed = projectCatalog({
    projects,
    threads: threads.toSorted((a, b) => b.updatedAt - a.updatedAt),
    selected: opened,
  })
  assert.deepEqual(refreshed.workspaces.items.map(item => item.path), expected)
})

test('目录排序忽略空白草稿，保存首条消息后计入原生更新时间', () => {
  const old = { id: 'old', cwd: '/alpha', updatedAt: 100 }
  const newer = { id: 'newer', cwd: '/beta', updatedAt: 200 }
  const draft = { id: 'draft', cwd: '/alpha', updatedAt: 300, blank: true, status: { type: 'idle' } }
  const listing = projectCatalog({ projects: [], threads: [draft, newer, old], selected: draft })
  assert.deepEqual(listing.workspaces.items.map(item => item.path), ['/beta', '/alpha'])
  assert.deepEqual(listing.workspaces.items[1].sessionIds, [draft.id, old.id])

  const saved = { ...draft, blank: false, preview: '首条消息', updatedAt: 400 }
  const refreshed = projectCatalog({ projects: [], threads: [saved, newer, old], selected: saved })
  assert.deepEqual(refreshed.workspaces.items.map(item => item.path), ['/alpha', '/beta'])
})

test('DSH 列表根据原生固定分组与归档状态标记会话', () => {
  const section = { id: '01984de2-8f74-7c91-a3b2-5c5e937cf318', name: 'Pinned' }
  const { sessions, workspaces } = projectCatalog({ projects: [], workspacePaths: {}, threads: [
    { id: 'native-pin', cwd: '/repo', section },
    { id: 'custom-group', cwd: '/repo', section: { id: 'different-id', name: section.name } },
    { id: 'archived', cwd: '/repo', archived: true, section },
  ] })
  assert.deepEqual(workspaces.pinnedSessionIds, ['native-pin', 'archived'])
  assert.deepEqual(workspaces.archivedSessionIds, ['archived'])
  assert.deepEqual(sessions.ids, ['native-pin', 'custom-group', 'archived'])
})

test('原生归档变更明确更新归档标记，置顶广播不冒充取消归档', async () => {
  const request = async () => ({ thread: { id: 'thread' } })
  const event = method => readCatalogEvent({ method, params: { threadId: 'thread' } }, request)
  assert.equal((await event('thread/archived')).thread.archived, true)
  assert.equal((await event('thread/section/changed')).thread.archived, undefined)
  assert.equal((await event('thread/unarchived')).thread.archived, false)
})

test('子代理可供原生子会话树读取，同时保留父工作区的根会话清单', () => {
  const root = { id: 'root', cwd: '/repo' }
  const child = {
    id: 'child', parentThreadId: root.id, cwd: '/repo', createdAt: 100, agentNickname: 'Scout', status: { type: 'active' },
    canAcceptDirectInput: true,
    source: { subAgent: { thread_spawn: { parent_thread_id: root.id, agent_path: '/root/check' } } },
  }
  const grandchild = {
    id: 'grandchild', cwd: '/repo', createdAt: 110, agentRole: 'Reviewer',
    canAcceptDirectInput: false,
    source: { subAgent: { thread_spawn: { parent_thread_id: child.id } } },
  }
  const legacy = { id: 'legacy', name: 'Legacy', parentThreadId: child.id, createdAt: 120 }
  const { sessions, workspaces } = projectCatalog({ projects: [], workspacePaths: {}, threads: [root], selected: grandchild,
    childThreads: { child, grandchild, legacy },
    childCatalogs: { root: { state: 'idle', ids: [child.id] }, child: { state: 'idle', ids: [grandchild.id, legacy.id] } },
  })
  assert.deepEqual(sessions.projectionsBySession.root.values.subagentCatalog, [{ id: 'child', label: '/root/check', createdAt: 100_000, mode: 'continuable' }])
  assert.deepEqual(sessions.projectionsBySession.child.values.subagentCatalog, [
    { id: 'grandchild', label: 'Reviewer', createdAt: 110_000, mode: 'unknown' },
    { id: 'legacy', label: 'Legacy', createdAt: 120_000, mode: 'continuable' },
  ])
  assert.equal(sessions.byId.grandchild.origin, 'subagent')
  assert.equal(sessions.byId[sessions.byId.grandchild.parentId].id, child.id)
  assert.equal(sessions.byId.child.origin, 'subagent')
  assert.equal(sessions.byId[sessions.byId.child.parentId].id, root.id)
  assert.equal(sessions.byId.root.origin, undefined)
  assert.equal(sessions.byId.child.running, true)
  assert.deepEqual(sessions.byId.grandchild.retainedBy, { mainView: 1 })
  assert.deepEqual(workspaces.items[0].sessionIds, ['root'])
  assert.deepEqual(sessions.ids, ['root'])
})
