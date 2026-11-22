import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const runtime = join(root, '.runtime')
const pluginName = 'dsh-chatgpt'
const profileName = 'codex'
const argv = process.argv.slice(2)
const delimiter = argv.indexOf('--')
const options = delimiter === -1 ? argv : argv.slice(0, delimiter)
const fresh = options.includes('--fresh-profile')
const dshArgs = [...options.filter(arg => arg !== '--fresh-profile'), ...argv.slice(options.length)]

async function legacyProfilePatch(home, profile, manifest) {
  const { dsh } = JSON.parse(await readFile(manifest, 'utf8'))
  if (dsh?.profile?.bundles?.includes(pluginName)) return
  const { composeEntries, loadOptionalPatches, loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
  const layers = [join(profile, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]
    .map(path => loadOptionalPatches('dsh', path) ?? [])
  const entries = composeEntries(layers)
  if (!entries.some(entry => entry.name === pluginName)) return
  const defaults = composeEntries([loadOverlayPatches('dsh', join(root, 'profile', 'cordis.patch.yml'))])
  const viewIds = new Set(['ui-goal', 'ui-sidebar-files'])
  const configured = new Set(entries.map(entry => entry.id))
  const missing = defaults.filter(entry => viewIds.has(entry.id) && !configured.has(entry.id))
  if (!missing.length) return
  // 命令行补丁最后加载。先用 DSH 的合成器处理原来找不到目标的用户覆盖项。
  const missingIds = new Set(missing.map(entry => entry.id))
  const insert = composeEntries([[{ insert: missing }], ...layers]).filter(entry => missingIds.has(entry.id))
  const { stringifyEntryYaml } = await import('@deepseek-ai/cordis-plugin-include')
  const path = join(runtime, 'legacy-profile.patch.yml')
  await writeFile(path, stringifyEntryYaml([{ insert }]))
  return path
}

async function prepareProfile(home) {
  const profile = join(home, 'profiles', profileName)
  const modules = join(profile, 'node_modules')
  const plugin = join(modules, pluginName)
  await mkdir(modules, { recursive: true })
  try {
    await symlink(root, plugin, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code !== 'EEXIST' || await realpath(plugin) !== await realpath(root)) throw error
  }

  const manifest = join(profile, 'package.json')
  if (existsSync(manifest)) return legacyProfilePatch(home, profile, manifest)

  // 组合包提供插件默认配置，DSH 的用户补丁可独立保存。先写完整清单再创建链接，避免并发启动读到半份文件。
  const staging = await mkdtemp(join(profile, '.initialize-'))
  try {
    const source = join(staging, 'package.json')
    await writeFile(source, JSON.stringify({
      name: 'dsh-chatgpt-profile',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pluginName] } },
    }, null, 2) + '\n')
    await link(source, manifest).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

await mkdir(runtime, { recursive: true })
const home = fresh ? await mkdtemp(join(runtime, 'dsh-fresh-')) : join(runtime, 'dsh')
try {
  const legacyPatch = await prepareProfile(home)
  const executable = process.env.DSH_CHATGPT_DSH_BIN || 'dsh'
  const child = spawn(executable, ['--profile', profileName, ...(legacyPatch ? ['--patch', legacyPatch] : []), ...dshArgs], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_CHATGPT_CACHE_DIR: process.env.DSH_CHATGPT_CACHE_DIR ?? join(fresh ? home : runtime, 'cache'),
    },
    stdio: 'inherit',
    // POSIX 终端会向前台进程组广播 Ctrl+C，由启动脚本向 DSH 转发一次。
    detached: process.platform !== 'win32',
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  const [code] = await once(child, 'close')
  process.exitCode = code ?? 1
} catch (error) {
  console.error(`无法启动 DSH：${error.message}`)
  process.exitCode = 1
} finally {
  if (fresh) await rm(home, { recursive: true, force: true })
}
