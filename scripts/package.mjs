import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = join(root, 'artifacts')
const archive = `${pkg.name}-${pkg.version}.tgz`

await mkdir(artifacts, { recursive: true })
execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--quiet', '--pack-destination', artifacts,
  '--cache', join(root, '.runtime', 'npm-cache')], { cwd: root, stdio: 'inherit' })

// 只清理本插件的旧版本，保留刚打出的包和最近三个历史版本。
const older = await Promise.all((await readdir(artifacts, { withFileTypes: true }))
  .filter(file => file.isFile() && file.name !== archive && /^dsh-chatgpt-\d+\.\d+\.\d+(?:[-+][\da-z.+-]+)?\.tgz$/i.test(file.name))
  .map(async file => {
    const path = join(artifacts, file.name)
    return { path, modified: (await stat(path)).mtimeMs }
  }))
older.sort((left, right) => right.modified - left.modified)
for (const { path } of older.slice(3)) await rm(path)

console.log(join(artifacts, archive))
