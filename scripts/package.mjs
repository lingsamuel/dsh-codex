import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'artifacts')
const cache = join(root, '.runtime', 'npm-cache')
const archive = `${pkg.name}-${pkg.version}.tgz`
const webArchive = `${pkg.name}-web-${pkg.version}.tgz`

await mkdir(artifacts, { recursive: true })
execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--quiet', '--pack-destination', artifacts,
  '--cache', cache], { cwd: root, stdio: 'inherit' })

// 两种入口共用同一套代码和插件 ID。官方 Web 安装包只装配扩展自身，
// 独立安装包继续负责完整的 Codex profile。
const staging = await mkdtemp(join(root, '.runtime', 'web-package-'))
try {
  for (const file of [...pkg.files, 'README.md']) {
    const target = join(staging, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, file), target, { recursive: true })
  }
  const web = { ...pkg, dsh: { ...pkg.dsh, bundle: { patch: './profile/web-mode.yml' } } }
  await writeFile(join(staging, 'package.json'), JSON.stringify(web, null, 2) + '\n')
  execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--quiet', '--ignore-scripts',
    '--pack-destination', staging, '--cache', cache], { cwd: staging, stdio: 'inherit' })
  await rename(join(staging, archive), join(artifacts, webArchive))
} finally {
  await rm(staging, { recursive: true, force: true })
}

// 只清理本插件的旧版本，保留刚打出的包和最近三个历史版本。
const older = await Promise.all((await readdir(artifacts, { withFileTypes: true }))
  .filter(file => file.isFile() && file.name !== archive && file.name !== webArchive && /^dsh-chatgpt-(?:web-)?\d+\.\d+\.\d+(?:[-+][\da-z.+-]+)?\.tgz$/i.test(file.name))
  .map(async file => {
    const path = join(artifacts, file.name)
    return { path, web: file.name.startsWith('dsh-chatgpt-web-'), modified: (await stat(path)).mtimeMs }
  }))
older.sort((left, right) => right.modified - left.modified)
for (const web of [false, true]) {
  for (const { path } of older.filter(file => file.web === web).slice(3)) await rm(path)
}

console.log(join(artifacts, archive))
console.log(join(artifacts, webArchive))
