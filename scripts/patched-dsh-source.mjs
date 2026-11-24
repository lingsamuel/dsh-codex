import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyPatch, parsePatch } from 'diff'

/** 构建从锁定的依赖读取原版源码，补丁只影响当前产物。 */
export async function patchedDshSource(packageName, ...files) {
  const root = fileURLToPath(new URL('./src/', import.meta.resolve(packageName + '/package.json')))
  const diffs = await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), 'utf8')))
  const sources = new Map(await Promise.all(diffs.flatMap(diff => parsePatch(diff).map(async patch => {
    const path = join(root, patch.oldFileName.slice(2))
    const contents = applyPatch(await readFile(path, 'utf8'), patch)
    if (contents === false) throw new Error(`上游源码补丁无法应用到 ${path}。`)
    return [path, { contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: dirname(path) }]
  }))))
  return {
    name: packageName.slice(packageName.lastIndexOf('/') + 1) + '-source',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, ({ path }) => sources.get(path))
    },
  }
}
