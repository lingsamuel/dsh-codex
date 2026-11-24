import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

const root = fileURLToPath(new URL('../', import.meta.url))
const development = process.argv.includes('--dev')
const artifacts = join(root, 'artifacts', development ? 'dev' : '')
const runtime = join(root, '.runtime')
const cache = join(runtime, 'npm-cache')
const artifactName = pkg.name.split('/').at(-1)
const versionedArchive = new RegExp(`^${RegExp.escape(artifactName)}-(?:min-)?(\\d+\\.\\d+\\.\\d+(?:[-+][\\da-z.+-]+)?)\\.tgz$`, 'i')

await mkdir(artifacts, { recursive: true })
await mkdir(runtime, { recursive: true })

const staging = await mkdtemp(join(runtime, 'plugin-package-'))
function npm(cwd, args, stdout = 'pipe') {
  return execFileSync(process.execPath, [process.env.npm_execpath, '--cache', cache, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', stdout, 'inherit'],
  })
}

// npm 决定临时归档的名称。最终产物沿用不带 scope 的文件名。
function pack(cwd) {
  const output = npm(cwd, ['pack', '--json', '--ignore-scripts', '--pack-destination', staging])
  const [{ filename }] = JSON.parse(output)
  return join(staging, filename)
}

// 只清理当前产物目录里本插件的旧版本，保留刚打出的包和最近三个历史版本。
async function pruneArchives(version) {
  const older = []
  for (const file of await readdir(artifacts, { withFileTypes: true })) {
    if (!file.isFile()) continue
    const match = versionedArchive.exec(file.name)
    if (!match || match[1] === version) continue
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
}

try {
  const content = join(staging, 'plugin')
  const manifestPath = join(content, 'package.json')
  const buildArgs = ['run', 'build']
  if (development) buildArgs.push('--', join(content, 'dist'))
  npm(root, buildArgs, 'inherit')

  for (const file of [...pkg.files, 'README.md']) {
    if (development && file.startsWith('dist/')) continue
    const target = join(content, file)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, file), target, { recursive: true })
  }
  await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + '\n')
  if (development) {
    // 每份暂存清单只升一次版本。时间和进程号区分连续或并行构建。
    npm(content, ['version', 'prerelease', `--preid=dev.${Date.now()}.${process.pid}`,
      '--no-git-tag-version', '--ignore-scripts'])
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const { version } = manifest
  const archive = `${artifactName}-${version}.tgz`
  const minArchive = `${artifactName}-min-${version}.tgz`

  await rename(pack(content), join(staging, minArchive))
  manifest.dsh.bundle.patch = './profile/web-mode.yml'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await rename(pack(content), join(artifacts, archive))
  await rename(join(staging, minArchive), join(artifacts, minArchive))

  await pruneArchives(version)
  console.log(join(artifacts, archive))
  console.log(join(artifacts, minArchive))
} finally {
  await rm(staging, { recursive: true, force: true })
}
