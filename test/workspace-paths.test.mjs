import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveWorkspacePaths } from '../src/host/workspace-paths.mjs'
import { groupThreads } from '../src/client/workspaces.js'

test('把大小写路径别名归一到同一真实目录，保留 Linux 上不同的目录身份', async t => {
  await mkdir('.runtime', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'paths-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'ModernInputSystem')
  const alias = join(directory, 'moderninputsystem')
  const separate = join(directory, 'MODERNINPUTSYSTEM')
  const missing = join(directory, 'modernInputSystem')
  await mkdir(project)
  await symlink(project, alias, 'dir')
  await mkdir(separate)

  const workspacePaths = await resolveWorkspacePaths([alias, project, separate, missing])
  assert.equal(workspacePaths[alias], project)
  assert.equal(workspacePaths[project] ?? project, project)
  assert.equal(workspacePaths[separate] ?? separate, separate)
  assert.equal(workspacePaths[missing], undefined)

  const threads = [
    { id: 'a', cwd: alias },
    { id: 'b', cwd: project },
    { id: 'c', cwd: separate },
  ]
  const groups = groupThreads(threads, [], workspacePaths)
  assert.deepEqual(groups.map(([, group]) => [group.name, group.threads.map(thread => thread.id)]), [
    ['ModernInputSystem', ['a', 'b']],
    ['MODERNINPUTSYSTEM', ['c']],
  ])
  assert.equal(groups[0][1].threads[0].cwd, alias)
})
