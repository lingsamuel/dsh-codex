import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshTrajectorySource } from './dsh-trajectory.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const outdir = process.argv[2] ?? 'dist'
const { name } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const trajectoryLicenses = await Promise.all([
  '@deepseek-ai/dsh-client-ui-trajectory', '@tanstack/react-virtual', '@tanstack/virtual-core',
].map(async name => {
  const notice = await readFile(new URL('./LICENSE', import.meta.resolve(`${name}/package.json`)), 'utf8')
  return `/*! ${name}\n${notice.trimEnd()}\n*/`
}))

const client = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/plugin.jsx'],
  outfile: join(outdir, 'client.js'),
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  plugins: [await dshTrajectorySource()],
  platform: 'browser',
  write: false,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: `${trajectoryLicenses.join('\n')}\nwindow.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { const module = { exports: {} };`,
  },
  footer: { js: 'return module.exports; }' },
})
const clientEntry = client.outputFiles.find(file => file.path.endsWith('.js'))
const clientStyles = client.outputFiles.find(file => file.path.endsWith('.css'))
// DSH 渲染器负责安装和卸载原生设置组件随包导出的 CSS。
const styleMeta = clientStyles ? `, meta: () => ({ stylesheets: { 'client.css': { text: () => ${JSON.stringify(clientStyles.text)} } } })` : ''
await mkdir(dirname(clientEntry.path), { recursive: true })
await writeFile(clientEntry.path, `${clientEntry.text.trimEnd()}${styleMeta} });\n`)

// 新版 DSH 随包发布搜索模块的 TypeScript 源码，由项目构建产出 Host 可加载的 JavaScript。
await build({
  absWorkingDir: root,
  entryPoints: {
    'file-reference-search': fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-file-reference-local/src/search.ts')),
    'session-markdown': 'src/host/session-markdown.mjs',
  },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
})

// 媒体路由与正在运行的 DSH 文件系统须共用 FsError，才能保留原版错误响应。
await build({
  absWorkingDir: root,
  entryPoints: [fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-api-session-controller/src/media-references.ts'))],
  outfile: join(outdir, 'session-media-references.mjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['@deepseek-ai/dsh-fs'],
  banner: { js: `import { createRequire } from 'node:module'
const hostRequire = createRequire(import.meta.url)
export function createSessionMediaReferences(fileSystem) {
  const module = { exports: {} }
  const require = id => id === '@deepseek-ai/dsh-fs' ? fileSystem : hostRequire(id)` },
  footer: { js: '  return module.exports.SessionMediaReferences\n}' },
})
