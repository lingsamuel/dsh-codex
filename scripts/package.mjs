import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'artifacts')
const runtime = join(root, '.runtime')
const cache = join(runtime, 'npm-cache')
const archive = `${pkg.name}-${pkg.version}.tgz`
const minArchive = `${pkg.name}-min-${pkg.version}.tgz`

await mkdir(artifacts, { recursive: true })
await mkdir(runtime, { recursive: true })

// npm pack 按同一个插件名生成归档。两份包在临时目录构建完成后再写入产物目录。
const staging = await mkdtemp(join(runtime, 'plugin-package-'))
try {
  execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--quiet',
    '--pack-destination', staging, '--cache', cache], { cwd: root, stdio: 'inherit' })
  await rename(join(staging, archive), join(staging, minArchive))

  const web = join(staging, 'web')
  for (const file of [...pkg.files, 'README.md']) {
    const target = join(web, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, file), target, { recursive: true })
  }
  const webManifest = { ...pkg, dsh: { ...pkg.dsh, bundle: { patch: './profile/web-mode.yml' } } }
  await writeFile(join(web, 'package.json'), JSON.stringify(webManifest, null, 2) + '\n')
  execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--quiet', '--ignore-scripts',
    '--pack-destination', staging, '--cache', cache], { cwd: web, stdio: 'inherit' })
  await rename(join(staging, minArchive), join(artifacts, minArchive))
  await rename(join(staging, archive), join(artifacts, archive))
} finally {
  await rm(staging, { recursive: true, force: true })
}

await rm(join(artifacts, `${pkg.name}-web-${pkg.version}.tgz`), { force: true })

// 只清理本插件的旧版本，保留刚打出的包和最近三个历史版本。
const older = []
for (const file of await readdir(artifacts, { withFileTypes: true })) {
  if (!file.isFile()) continue
  const match = /^dsh-chatgpt-(?:(?:min|web)-)?(\d+\.\d+\.\d+(?:[-+][\da-z.+-]+)?)\.tgz$/i.exec(file.name)
  if (!match || match[1] === pkg.version) continue
  const path = join(artifacts, file.name)
  try {
    older.push({ path, version: match[1], modified: (await stat(path)).mtimeMs })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
older.sort((left, right) => right.modified - left.modified)
const versions = [...new Set(older.map(file => file.version))].slice(0, 3)
for (const { path, version } of older) {
  if (!versions.includes(version)) await rm(path, { force: true })
}

console.log(join(artifacts, archive))
console.log(join(artifacts, minArchive))
