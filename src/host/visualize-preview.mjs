import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isVisualizePath } from '../shared/visualize-reference.js'

const run = promisify(execFile)
export const visualizeMaxBytes = 1_000_000
const previewRuntime = fileURLToPath(new URL('../../.runtime/visualize/', import.meta.url))
// 读取独立预览测得的内联高度，避免容器布局时的备用高度反向触发尺寸变更。
const previewSizing = `<style>body { padding: 0 } #codex-visualization { height: 24rem }</style>
<script>
  const preview = document.getElementById('codex-visualization');
  if (preview) {
    const report = () => {
      const height = Number.parseFloat(preview.style.height);
      if (Number.isFinite(height)) parent.postMessage({ type: 'dsh-visualize-height', height }, '*');
    };
    new MutationObserver(report).observe(preview, { attributes: true, attributeFilter: ['style'] });
    report();
  }
</script>`

async function findRenderer(codexHome) {
  const cache = join(codexHome, 'plugins/cache/openai-curated-remote/visualize')
  const entries = await readdir(cache, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const versions = entries.filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
  for (const { name } of versions) {
    const candidate = join(cache, name, 'skills/visualize/scripts/render.py')
    if (await access(candidate).then(() => true, () => false)) return candidate
  }
}

function previewError(status, error) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** 在 DSH 受保护的入口渲染现有片段，浏览器只接收预览文档。 */
export function createVisualizeRoute(readSource, {
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  runtime = previewRuntime,
} = {}) {
  return {
    path: '/api/codex/visualize',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const { searchParams } = new URL(request.url)
      const threadId = searchParams.get('threadId')
      const path = searchParams.get('path')
      if (!threadId?.trim() || !isVisualizePath(path)) return previewError(400, '无效的 Visualize 引用。')
      const { signal } = request
      let source
      try {
        source = await readSource(threadId, path, signal)
      } catch {
        return previewError(404, '无法读取 Visualize 源文件。')
      }
      if (source.byteLength > visualizeMaxBytes) return previewError(413, 'Visualize 源文件超过 1 MB。')

      let directory
      try {
        const renderer = await findRenderer(codexHome)
        if (!renderer) return previewError(503, 'Codex 插件缓存中没有 Visualize 渲染器。')
        await mkdir(runtime, { recursive: true })
        directory = await mkdtemp(join(runtime, 'preview-'))
        const fragment = join(directory, 'fragment.html')
        // 让渲染器只访问 DSH 文件服务已读取的内容，避免再次打开引用中的原路径。
        await writeFile(fragment, source, { signal, mode: 0o600 })
        const { stdout } = await run('python3', ['-I', '-B', renderer, fragment, `--title=${win32.basename(path)}`], {
          signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
        })
        const html = stdout.replace('</body>', `${previewSizing}\n</body>`)
        return Response.json({ html }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
      } catch (error) {
        if (error.code === 'ENOENT') return previewError(503, '无法启动 Visualize 渲染器，请检查 Python 3 和 Codex 插件缓存。')
        return previewError(422, '无法渲染 Visualize 片段。')
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    },
  }
}
