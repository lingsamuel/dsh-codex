import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { name } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/plugin.jsx'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'browser',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { const module = { exports: {} };`,
  },
  footer: { js: 'return module.exports; } });' },
})

// 新版 DSH 随包发布搜索模块的 TypeScript 源码，由项目构建产出 Host 可加载的 JavaScript。
await build({
  absWorkingDir: root,
  entryPoints: {
    'file-reference-search': fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-file-reference-local/src/search.ts')),
    'session-markdown': 'src/host/session-markdown.mjs',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
})
