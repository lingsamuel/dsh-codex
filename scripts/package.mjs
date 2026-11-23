import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'artifacts')
const runtime = join(root, '.runtime')
const cache = join(runtime, 'npm-cache')
const artifactName = pkg.name.split('/').at(-1)
const archive = `${artifactName}-${pkg.version}.tgz`
const minArchive = `${artifactName}-min-${pkg.version}.tgz`
const versionedArchive = new RegExp(`^${RegExp.escape(artifactName)}-(?:min-)?(\\d+\\.\\d+\\.\\d+(?:[-+][\\da-z.+-]+)?)\\.tgz$`, 'i')

await mkdir(artifacts, { recursive: true })
await mkdir(runtime, { recursive: true })

// npm 决定临时归档的名称。正式产物沿用不带 scope 的文件名。
const staging = await mkdtemp(join(runtime, 'plugin-package-'))
function pack(cwd, args = []) {
  const output = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json',
    '--pack-destination', staging, '--cache', cache, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const [{ filename }] = JSON.parse(output)
  return join(staging, filename)
}

try {
  await rename(pack(root), join(staging, minArchive))

  const web = join(staging, 'web')
  for (const file of [...pkg.files, 'README.md']) {
    const target = join(web, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, file), target, { recursive: true })
  }
  const webManifest = { ...pkg, dsh: { ...pkg.dsh, bundle: { patch: './profile/web-mode.yml' } } }
  await writeFile(join(web, 'package.json'), JSON.stringify(webManifest, null, 2) + '\n')
  const webArchive = pack(web, ['--ignore-scripts'])
  await rename(join(staging, minArchive), join(artifacts, minArchive))
  await rename(webArchive, join(artifacts, archive))
} finally {
  await rm(staging, { recursive: true, force: true })
}

// 只清理本插件的旧版本，保留刚打出的包和最近三个历史版本。
const older = []
for (const file of await readdir(artifacts, { withFileTypes: true })) {
  if (!file.isFile()) continue
  const match = versionedArchive.exec(file.name)
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
