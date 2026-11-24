import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const source = new URL('../src/client/native-dsh/turn-changes.jsx', import.meta.url)

async function load() {
  const primitives = `import { createElement } from ${JSON.stringify(import.meta.resolve('react'))}
    export const DisclosureRow = ({ title, icon, children, collapsedContent }) => createElement('section', {}, icon, title, collapsedContent, children)
    export const FileTypeIcon = ({ path }) => createElement('i', { 'data-path': path })
    export const PathLabel = ({ path }) => createElement('span', { 'data-path-label': '', title: path }, path)
    export const Button = 'button', CodeBlock = 'code', DiffBlock = 'pre'
    export const IconChevronDownOutlineRegular = 'i', IconChevronUpOutlineRegular = 'i',
      IconEditOutlineRegular = 'i', IconInspectOutlineRegular = 'i'`
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
        return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(primitives)}` }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url !== source.href) return next(url, context)
      const { code } = transformSync(readFileSync(source, 'utf8'), { loader: 'jsx', jsx: 'automatic' })
      return { format: 'module', shortCircuit: true, source: code }
    },
  })
  try { return await import(source) } finally { hook.deregister() }
}

test('多文件编辑用原生路径标签承载每个文件的完整路径', async () => {
  const { installTurnChanges } = await load()
  const edit = { options: { key: 'edit' }, inject: () => ({}), component: () => null }
  installTurnChanges({
    effect: callback => callback(), inject() {}, on: () => () => {},
    locale: { register() {}, bind: () => (key, params) => key === 'files' ? `${params.count} 个文件有改动` : key },
    slots: { entries: () => [edit] },
  })
  const paths = ['/home/u/project/guide.md', '/mnt/c/Other Project/notes.txt']
  const changes = paths.map(path => ({ path, diffs: [] }))
  const html = renderToStaticMarkup(createElement(edit.component, {
    phase: 'result', block: { meta: { codexFileChanges: changes } },
    useDisclosure: () => ({ expanded: true, toggle() {} }),
  }))
  const labels = [...html.matchAll(/<span data-path-label="" title="([^"]+)">/g)].map(([, path]) => path)
  assert.deepEqual(labels, paths)
})
