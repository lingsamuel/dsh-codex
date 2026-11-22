import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCatalog } from '../src/client/native-dsh/catalog.js'

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
