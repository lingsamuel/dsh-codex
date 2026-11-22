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
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { const module = { exports: {} };`,
  },
  footer: { js: 'return module.exports; } });' },
})
