import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { applyPatch, parsePatch } from 'diff'

/** 复用官方视图的源码和样式，在构建时补入 Codex 页需要的两个布局参数。 */
export async function dshTrajectorySource() {
  const diff = await readFile(new URL('./dsh-trajectory.patch', import.meta.url), 'utf8')
  const patches = new Map(parsePatch(diff).map(patch => [basename(patch.oldFileName), patch]))
  return {
    name: 'dsh-trajectory-source',
    setup(build) {
      build.onLoad({ filter: /@deepseek-ai[/\\]dsh-client-ui-trajectory[/\\]src[/\\]client[/\\].*\.tsx?$/ }, async ({ path }) => {
        const patch = patches.get(basename(path))
        if (!patch) return
        const contents = applyPatch(await readFile(path, 'utf8'), patch)
        if (contents === false) {
          throw new Error(`DSH 轨迹源码补丁无法应用到 ${path}。`)
        }
        return { contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: dirname(path) }
      })
    },
  }
}
