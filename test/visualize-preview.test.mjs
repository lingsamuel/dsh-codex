import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createVisualizeRoute } from '../src/host/visualize-preview.mjs'

async function fixture(t) {
  const runtimeRoot = fileURLToPath(new URL('../.runtime/', import.meta.url))
  await mkdir(runtimeRoot, { recursive: true })
  const directory = await mkdtemp(join(runtimeRoot, 'test-visualize-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const renderers = join(directory, 'plugins/cache/openai-curated-remote/visualize')
  const renderer = join(renderers, '1.12.0/skills/visualize/scripts')
  const old = join(renderers, '1.9.0/skills/visualize/scripts')
  await mkdir(renderer, { recursive: true })
  await mkdir(old, { recursive: true })
  await writeFile(join(renderer, 'render.py'), 'import json, pathlib, sys\nprint(json.dumps(pathlib.Path(sys.argv[1]).read_text()))\n')
  await writeFile(join(old, 'render.py'), 'raise RuntimeError("old version")\n')
  const runtime = join(directory, 'runtime')
  const calls = []
  const source = '<button>月相</button>'
  const route = createVisualizeRoute(async (id, path, signal) => {
    assert.equal(signal.aborted, false)
    calls.push([id, path])
    if (path.endsWith('/missing.html')) throw new Error('unreadable')
    if (path.endsWith('/too-large.html')) return Buffer.alloc(1_000_001)
    return Buffer.from(source)
  }, { codexHome: directory, runtime })
  const request = (path, threadId = 'saved-thread') => route.fetch(new Request(
    `http://local${route.path}?${new URLSearchParams({ threadId, path })}`))
  return { renderers, renderer, runtime, request, calls, source }
}

test('读取会话中的源片段，运行缓存中最新的渲染脚本，并清理临时文件', async t => {
  const { request, runtime, calls, source } = await fixture(t)
  const response = await request('/work/moon phases.html')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  const { html } = await response.json()
  assert.equal(JSON.parse(html), source)
  assert.deepEqual(calls, [['saved-thread', '/work/moon phases.html']])
  assert.deepEqual(await readdir(runtime), [])
})

test('区分无效路径、文件读取失败、文件过大、渲染失败和缺少渲染器', async t => {
  const { request, calls, renderers, renderer, runtime } = await fixture(t)
  const invalid = await request('relative.html')
  assert.equal(invalid.status, 400)
  assert.deepEqual(calls, [])
  assert.equal((await request('/work/missing.html')).status, 404)
  assert.equal((await request('/work/too-large.html')).status, 413)
  const script = join(renderer, 'render.py')
  await writeFile(script, 'raise ValueError("invalid fragment")\n')
  assert.equal((await request('/work/moon.html')).status, 422)
  assert.deepEqual(await readdir(runtime), [])
  await rm(renderers, { recursive: true })
  assert.equal((await request('/work/moon.html')).status, 503)
})
