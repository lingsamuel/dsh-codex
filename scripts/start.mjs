import { spawn } from 'node:child_process'
import { copyFile, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const home = join(root, '.runtime', 'dsh')
const profile = join(home, 'profiles', 'codex')
const modules = join(profile, 'node_modules')
const plugin = join(modules, 'dsh-chatgpt')

await mkdir(modules, { recursive: true })
await copyFile(join(root, 'profile', 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'))
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-chatgpt-profile',
  private: true,
  dsh: { profile: { bundles: [] } },
}))
try {
  await symlink(root, plugin, process.platform === 'win32' ? 'junction' : 'dir')
} catch (error) {
  if (error.code !== 'EEXIST' || await realpath(plugin) !== await realpath(root)) throw error
}

const executable = process.env.DSH_CHATGPT_DSH_BIN || 'dsh'
const child = spawn(executable, ['--profile', 'codex', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
  // POSIX 终端会向前台进程组广播 Ctrl+C，由启动脚本向 DSH 转发一次。
  detached: process.platform !== 'win32',
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', error => {
  console.error(`无法启动 DSH：${error.message}`)
  process.exitCode = 1
})
child.on('exit', code => { process.exitCode = code ?? 1 })
