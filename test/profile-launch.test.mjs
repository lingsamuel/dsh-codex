import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEntryYaml, stringifyEntryYaml } from '@deepseek-ai/cordis-plugin-include'

const project = fileURLToPath(new URL('../', import.meta.url))
const dshManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const savedSetting = '- id: ui-conversation\n  config:\n    busyEnterBehavior: steer\n'
const fileActions = { id: 'ui-file-actions', name: '@deepseek-ai/dsh-client-ui-file-actions' }

async function fixture(t) {
  await mkdir(join(project, '.runtime'), { recursive: true })
  const root = await mkdtemp(join(project, '.runtime', 'profile-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, '.runtime')
  const profile = join(runtime, 'dsh', 'profiles', 'codex')
  const patch = join(profile, 'cordis.patch.yml')
  const launcher = join(root, 'scripts', 'start.mjs')
  const { bin } = JSON.parse(await readFile(dshManifest, 'utf8'))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'profile'))
  for (const file of ['scripts/start.mjs', 'package.json', 'profile/cordis.patch.yml']) {
    await copyFile(join(project, file), join(root, file))
  }
  // 配置预览经过真实的启动器和 DSH 配置加载流程，但不会启动 Web 服务。
  const dump = (...args) => execFileSync(process.execPath, [launcher, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_CHATGPT_DSH_BIN: join(dirname(dshManifest), bin.dsh) },
  })
  return { root, runtime, profile, patch, dump }
}

test('默认启动保留旧 Profile 的配置和已保存的网页设置', { skip: process.platform === 'win32' }, async t => {
  const { root, profile, patch, dump } = await fixture(t)
  const manifest = join(profile, 'package.json')
  const previousManifest = JSON.stringify({
    name: 'dsh-chatgpt-profile',
    description: 'Persistent profile',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const defaults = await readFile(join(root, 'profile', 'cordis.patch.yml'), 'utf8')
  const previousDefaults = parseEntryYaml(defaults).map(patch => patch.insert ? {
    insert: patch.insert.filter(entry => !['ui-goal', 'ui-sidebar-files', fileActions.id].includes(entry.id)),
  } : patch)
  const previousPatch = stringifyEntryYaml(previousDefaults) + savedSetting
  await mkdir(profile, { recursive: true })
  await writeFile(manifest, previousManifest)
  await writeFile(patch, previousPatch)

  const config = dump('--dump-config')
  assert.match(config, /busyEnterBehavior: steer/)
  assert.match(config, /name: ['"]?@deepseek-ai\/dsh-client-ui-goal/)
  assert.deepEqual(parseEntryYaml(config).find(entry => entry.id === fileActions.id), fileActions)
  assert.deepEqual(parseEntryYaml(config).find(entry => entry.id === 'ui-sidebar-files'), {
    id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files',
  })
  assert.equal(await readFile(patch, 'utf8'), previousPatch)
  assert.equal(await readFile(manifest, 'utf8'), previousManifest)
  const disabledFiles = '- id: ui-sidebar-files\n  disabled: true\n'
  await writeFile(patch, previousPatch + disabledFiles)
  const disabled = parseEntryYaml(dump('--dump-config')).find(entry => entry.id === 'ui-sidebar-files')
  assert.deepEqual(disabled, { id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files', disabled: true })
  await writeFile(patch, defaults + savedSetting + disabledFiles)
  const overridden = parseEntryYaml(dump('--dump-config'))
  assert.equal(overridden.filter(entry => entry.id === 'ui-goal').length, 1)
  assert.deepEqual(overridden.filter(entry => entry.id === 'ui-sidebar-files'), [
    { id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files', disabled: true },
  ])
})

test('临时 Profile 加载插件默认配置，并在进程退出后清理', { skip: process.platform === 'win32' }, async t => {
  const { runtime, patch, dump } = await fixture(t)
  assert.match(dump('--dump-default-config'), /name: dsh-chatgpt/)
  await writeFile(patch, savedSetting)
  assert.match(dump('--dump-config'), /busyEnterBehavior: steer/)

  const freshConfig = dump('--fresh-profile', '--dump-config')
  assert.match(freshConfig, /name: dsh-chatgpt/)
  assert.doesNotMatch(freshConfig, /busyEnterBehavior: steer/)
  assert.deepEqual(parseEntryYaml(freshConfig).find(entry => entry.id === fileActions.id), fileActions)
  assert.deepEqual(parseEntryYaml(freshConfig).find(entry => entry.id === 'ui-sidebar-files'), {
    id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files',
  })
  assert.throws(() => dump('--fresh-profile', '--dump-config', '--dump-default-config'), { status: 1 })
  assert.deepEqual(await readdir(runtime), ['dsh'])
  assert.equal(await readFile(patch, 'utf8'), savedSetting)
})
