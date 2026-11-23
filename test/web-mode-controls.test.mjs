import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { transformSync } from 'esbuild'

const source = new URL('../src/client/web-mode.jsx', import.meta.url)

async function loadControls() {
  const stubs = {
    react: `export const useSyncExternalStore = (_subscribe, read) => read()`,
    'react/jsx-runtime': `export const Fragment = Symbol(), jsx = (type, props) => ({ type, props }), jsxs = jsx`,
    '@deepseek-ai/dsh-client-store': `export function createSnapshotStore(value) {
      return { getSnapshot: () => value, subscribe: () => () => {}, set(next) { value = next } }
    }`,
    '@deepseek-ai/dsh-client-ui-primitives': `export const Switch = 'switch', Button = 'button', Modal = 'modal',
      FishLogo = 'fish-logo', BrandWordmark = 'official-wordmark'`,
  }
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (stubs[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}` }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (!url.startsWith(new URL('../src/client/', import.meta.url).href) || !url.endsWith('.jsx')) return next(url, context)
      const { code } = transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'jsx', jsx: 'automatic' })
      return { format: 'module', shortCircuit: true, source: code }
    },
  })
  try { return await import(source) } finally { hook.deregister() }
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (typeof node?.type === 'function') return elements(node.type(node.props))
  return [node, ...Object.values(node?.props ?? {}).filter(value => value?.type || Array.isArray(value)).flatMap(elements)]
}

function fixture(t) {
  const registration = new Map()
  const workspace = { component: props => ({ type: 'workspace', props }) }
  const component = workspace.component
  const forms = []
  const navigations = []
  const installers = []
  let copy
  const globals = {
    document: {
      baseURI: 'https://dsh.test/profile/',
      querySelector: () => null,
      body: { append() {} },
      createElement(type) { return { type, children: [], append(child) { this.children.push(child) }, submit() { forms.push(this) } } },
    },
    window: { addEventListener() {}, location: { search: '?mode=dsh', assign: url => navigations.push(url) } },
  }
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key))
  }
  const ctx = {
    effect(install) { installers.push(install()) },
    get() {},
    inject() {},
    locale: { register(_locale, dictionaries) { copy = dictionaries.zh }, bind: () => key => copy[key],
      getSnapshot: () => 'zh', subscribe: () => () => {} },
    slots: {
      subscribe: () => () => {},
      entries: slot => slot === 'sidebar.workspaces' ? [workspace] : [],
      entriesOfSlot: slot => slot === 'sidebar.workspaces' ? [workspace] : [],
      inject(_slot, install) { return install() },
      register(options, render) { registration.set(options.name, { options, render }) },
    },
  }
  return { ctx, forms, navigations, workspace, component, registration, copy: () => copy, undo: () => installers.reverse().forEach(fn => fn?.()) }
}

const coexist = { mode: 'dsh', available: true, coexist: true, exclusive: false, defaultMode: 'dsh' }

test('共存时开关显示当前模式，保存默认入口后直接切换当前标签页', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, forms, navigations, workspace, component, undo } = fixture(t)
  const writes = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    writes.push({ pathname: new URL(url).pathname, payload: JSON.parse(init.body) })
    return Response.json({ ...coexist, defaultMode: 'codex' })
  })
  installWebMode(ctx, { ...coexist, defaultMode: 'codex' })
  const panel = () => elements(workspace.component({ wide: true, session: 'dsh-session' }))
  const before = panel()
  const toggle = before.find(node => node?.type === 'switch')
  assert.equal(toggle.props.checked, false)
  assert.ok(before.indexOf(toggle) < before.findIndex(node => node?.type === 'workspace'))
  await toggle.props.onChange(true)
  assert.deepEqual(writes, [{ pathname: '/profile/api/codex/web-mode', payload: { defaultMode: 'codex', keepPage: true } }])
  assert.deepEqual(navigations, ['https://dsh.test/profile/?mode=codex'])
  assert.equal(panel().find(node => node?.type === 'workspace').props.session, 'dsh-session')
  assert.deepEqual(forms, [])
  undo()
  assert.equal(workspace.component, component)
})

test('独占时隐藏所有模式入口，退出独占保留共存的 Codex 页面', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, forms, navigations, workspace, registration, copy, undo } = fixture(t)
  const writes = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    writes.push(JSON.parse(init.body))
    return Response.json({ ...coexist, mode: 'codex' })
  })
  installWebMode(ctx, { ...coexist, mode: 'codex', exclusive: true })
  assert.equal(elements(workspace.component({ wide: true })).some(node => node?.type === 'switch'), false)
  const { options, render } = registration.get('plugins.bundle.config')
  assert.equal(options.key, 'dsh-codex')
  const view = elements(render({ ...options.inject(), t: key => copy()[key] }))
  const settings = view.filter(node => node?.type === 'switch')
  assert.deepEqual(settings.map(setting => setting.props.checked), [true, true])
  assert.equal(settings[0].props.disabled, true)
  assert.equal(view.some(node => node?.type === 'button'), false)
  const brand = registration.get('sidebar.brand.name')
  const badge = elements(brand.render(brand.options.inject())).find(node => node?.props?.['data-codex-mode-badge'] === '')
  await badge.props.onClick({ stopPropagation() {} })
  assert.deepEqual(writes, [])
  await settings[1].props.onChange(false)
  assert.deepEqual(writes, [{ exclusive: false, keepPage: true }])
  assert.deepEqual(navigations, [])
  assert.deepEqual(forms, [])
  undo()
})

test('在 DSH 页面打开独占时直接保存偏好，成功后进入 Codex', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, forms, navigations, registration, copy, undo } = fixture(t)
  const writes = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    writes.push(JSON.parse(init.body))
    return Response.json({ ...coexist, exclusive: true, mode: 'codex' })
  })
  installWebMode(ctx, coexist)
  const { options, render } = registration.get('plugins.bundle.config')
  const settings = elements(render({ ...options.inject(), t: key => copy()[key] })).filter(node => node?.type === 'switch')
  await settings[1].props.onChange(true)
  assert.deepEqual(writes, [{ exclusive: true }])
  assert.deepEqual(navigations, ['https://dsh.test/profile/?mode=codex'])
  assert.deepEqual(forms, [])
  undo()
})

test('其他 DSH 页面发现独占后隐藏开关并提示重新加载', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, workspace, registration, copy, undo } = fixture(t)
  let refresh
  t.mock.method(window, 'addEventListener', (event, listener) => {
    if (event === 'focus') refresh = listener
  })
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).searchParams.get('mode'), 'dsh')
    return Response.json({ ...coexist, exclusive: true, mode: 'codex' })
  })
  installWebMode(ctx, coexist)
  await refresh()
  assert.equal(elements(workspace.component({ wide: true })).some(node => node?.type === 'switch'), false)
  const { options, render } = registration.get('shell.overlay')
  const modal = elements(render({ ...options.inject(), t: key => copy()[key] })).find(node => node?.type === 'modal')
  assert.equal(modal.props.description, '实例模式已改变，请重新加载当前页面。')
  undo()
})

test('黑色徽标触发原生侧栏同样的模式切换，避免向上触发新建会话', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, navigations, registration } = fixture(t)
  const writes = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    writes.push(JSON.parse(init.body))
    return Response.json({ ...coexist, defaultMode: 'codex' })
  })
  installWebMode(ctx, coexist)
  const { options, render } = registration.get('sidebar.brand.name')
  const nodes = elements(render(options.inject()))
  const badge = nodes.find(node => node?.props?.['data-codex-mode-badge'] === '')
  let stopped = false
  await badge.props.onClick({ stopPropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.deepEqual(writes, [{ defaultMode: 'codex', keepPage: true }])
  assert.deepEqual(navigations, ['https://dsh.test/profile/?mode=codex'])
})

test('原生会话仍在提交时不导航到整实例切换页', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, forms, workspace, undo } = fixture(t)
  const services = {
    sessions: { list: { getSnapshot: () => ({ byId: { thread: {} } }) }, binding: () => ({ ctx: {}, session: {} }) },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ phase: 'sending' }) } }) } },
  }
  ctx.get = name => services[name]
  installWebMode(ctx, { ...coexist, coexist: false })
  const panel = () => elements(workspace.component({ wide: true }))
  await panel().find(node => node?.type === 'switch').props.onChange(true)
  assert.deepEqual(forms, [])
  assert.equal(panel().find(node => node?.props?.role === 'status').props.children[0], '请等待当前的提交完成。')
  undo()
})

test('Host 拒绝整实例切换时保留当前页面和原模式', async t => {
  const { installWebMode } = await loadControls()
  const { ctx, forms, navigations, workspace, undo } = fixture(t)
  const current = { ...coexist, coexist: false }
  const writes = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(document.body.inert, true)
    writes.push(JSON.parse(init.body))
    return Response.json({ ...current, error: '正在切换 Web 模式。' }, { status: 409 })
  })
  installWebMode(ctx, current)
  const panel = () => elements(workspace.component({ wide: true }))
  await panel().find(node => node?.type === 'switch').props.onChange(true)
  assert.deepEqual(writes, [{ defaultMode: 'codex' }])
  assert.deepEqual(navigations, [])
  assert.deepEqual(forms, [])
  assert.equal(Boolean(document.body.inert), false)
  assert.equal(panel().find(node => node?.type === 'switch').props.checked, false)
  assert.equal(panel().find(node => node?.props?.role === 'status').props.children[0], '正在切换 Web 模式。')
  undo()
})
