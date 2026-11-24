import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-terminal-controller/typert'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { createSidebarTerminalOwners, installCodexSidebarTerminals } from '../src/host/sidebar-terminals.mjs'
import { codexTerminalDescriptors, codexTerminalNamespace, encodeTerminalScope } from '../src/shared/sidebar-terminals.js'

const draftId = 'web-new-11111111-2222-3333-4444-555555555555'
const selection = { kind: 'new', id: '11111111-2222-4333-8444-555555555555', baseRef: 'refs/heads/main' }
const terminalRequest = id => ({ id, cols: 100, rows: 24, shellPath: '/bin/sh' })

class FixtureSubprocess extends LocalSubprocessRuntime {
  async terminalEnvironment(signal) {
    return { ...await super.terminalEnvironment(signal), defaultShell: '/bin/sh' }
  }
}

async function fixture(t) {
  await mkdir('.runtime', { recursive: true })
  const cwd = await mkdtemp(join(process.cwd(), '.runtime', 'terminal-'))
  const checkout = join(cwd, 'worktree')
  await mkdir(checkout)
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(cwd, { force: true, recursive: true })
  })
  ctx.provide('loader', { import: specifier => import(specifier) })
  // 让 Gateway 策略层放行非 owner，单独验证终端服务仍然拒绝。
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
  ctx.provide('sandboxPolicy', {})
  ctx.provide('workingDirectory', { get: () => cwd, ensure: () => cwd })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(FixtureSubprocess)
  await ctx.plugin(TerminalController)
  ctx.typert.register(TYPERT)

  const owners = createSidebarTerminalOwners()
  const reads = []
  const worktrees = []
  const workspaces = new Map([['thread', cwd], ['other', cwd]])
  let active = true
  const host = await ctx.inject(['typert', 'subprocess', 'sandboxPolicy'], scope => installCodexSidebarTerminals(scope, {
    owners,
    available: () => active,
    async readWorkspace(id) {
      reads.push(id)
      return workspaces.get(id)
    },
    async resolveDraftWorktree(id, cwd, worktree) {
      worktrees.push({ id, cwd, worktree })
      return checkout
    },
  }))
  const owner = { id: 'owner', ctx, principal: { kind: 'owner' }, signal: t.signal }
  const guest = { ...owner, id: 'guest', principal: { kind: 'guest' } }
  const definitions = new Map(codexTerminalDescriptors(TYPERT.invocations).map(value => [value.method, value]))
  const request = (method, scope, fields, options) => ({
    namespace: codexTerminalNamespace,
    method,
    args: { [definitions.get(method).parameters[0].wire]: scope, ...fields },
    peer: owner, signal: AbortSignal.any([t.signal, AbortSignal.timeout(12_000)]),
    ...options,
  })
  return {
    cwd, checkout, host, owners, reads, worktrees, workspaces, guest,
    invoke: (method, scope, fields, options) => ctx.typertGateway.invoke(request(method, scope, fields, options)),
    stream: (method, scope, fields, options) => ctx.typertGateway.stream(request(method, scope, fields, options)),
    nativeList: sessionId => ctx.typertGateway.invoke({ namespace: 'terminal', method: 'list', args: { sessionId }, peer: owner }),
    deactivate: () => { active = false },
  }
}

test('Codex 终端使用 Gateway 校验 owner 和当前工作目录，发现 shell 不创建 Worktree', async t => {
  const { cwd, checkout, reads, worktrees, workspaces, guest, invoke, nativeList, deactivate } = await fixture(t)
  const draft = encodeTerminalScope(draftId, cwd, selection)
  await assert.rejects(invoke('create', draft, { request: terminalRequest('guest') }, { peer: guest }), { code: 'remote-access/denied' })
  assert.deepEqual(worktrees, [])
  assert.equal((await invoke('environment', draft)).cwd, cwd)
  assert.equal((await invoke('shells', draft))[0].path, '/bin/sh')
  assert.deepEqual(worktrees, [])
  const created = await invoke('create', draft, { request: terminalRequest('draft-shell') })
  assert.equal(created.cwd, checkout)
  assert.deepEqual(worktrees, [{ id: draftId, cwd, worktree: selection }])
  assert.deepEqual(await nativeList(draftId), [])

  assert.equal((await invoke('environment', 'thread')).cwd, cwd)
  workspaces.set('thread', checkout)
  assert.equal((await invoke('create', 'thread', { request: terminalRequest('new-directory') })).cwd, checkout)
  assert.deepEqual(reads, ['thread', 'thread'])
  await assert.rejects(invoke('create', encodeTerminalScope(draftId, join(cwd, 'missing')), { request: terminalRequest('missing') }))
  assert.deepEqual((await invoke('list', draftId)).map(terminal => terminal.id), ['draft-shell'])
  deactivate()
  await assert.rejects(invoke('list', draftId))
})

test('草稿交接后真实线程的终端列表、保留与重新连接沿用同一 PTY', async t => {
  const { cwd, owners, invoke, stream } = await fixture(t)
  const draft = encodeTerminalScope(draftId, cwd)
  await invoke('create', draft, { request: terminalRequest('draft-shell') })
  await invoke('create', 'thread', { request: terminalRequest('native-shell') })
  const roster = (await stream('watch', 'thread'))[Symbol.asyncIterator]()
  assert.deepEqual((await roster.next()).value.map(terminal => terminal.id), ['native-shell'])

  async function* initialize() {
    yield { type: 'resize', sequence: 1, cols: 90, rows: 20 }
    yield { type: 'write', sequence: 2, data: 'saved=handover; printf "%s\\n" "$PWD"\r', typed: true }
  }
  const original = (await stream('attach', draftId, { id: 'draft-shell' }, { uplink: initialize() }))[Symbol.asyncIterator]()
  assert.equal((await original.next()).value.info.id, 'draft-shell')
  for (let output = ''; !output.includes(cwd);) {
    const next = await original.next()
    assert.equal(next.done, false)
    if (next.value.type === 'output') output += next.value.data
  }
  await original.return()

  owners.associate(draftId, 'thread')
  assert.deepEqual(new Set((await roster.next()).value.map(terminal => terminal.id)), new Set(['native-shell', 'draft-shell']))
  assert.deepEqual(await invoke('list', 'other'), [])
  await assert.rejects(stream('attach', 'other', { id: 'draft-shell' }), { code: 'terminal/unavailable' })
  const retained = (await stream('retain', 'thread', { id: 'draft-shell' }))[Symbol.asyncIterator]()
  assert.deepEqual((await retained.next()).value, { type: 'retained' })
  async function* verify() {
    yield { type: 'write', sequence: 1, data: 'printf "before-%s-after\\n" "$saved"\r', typed: true }
  }
  const reattached = (await stream('attach', 'thread', { id: 'draft-shell' }, { uplink: verify() }))[Symbol.asyncIterator]()
  const snapshot = (await reattached.next()).value
  assert.equal(snapshot.info.id, 'draft-shell')
  assert.equal(snapshot.info.cols, 90)
  assert.equal(snapshot.info.rows, 20)
  assert.ok(snapshot.screen.includes(cwd))
  for (let output = ''; !output.includes('before-handover-after');) {
    const next = await reattached.next()
    assert.equal(next.done, false)
    if (next.value.type === 'output') output += next.value.data
  }
  await reattached.return()
  await retained.return()
  await invoke('close', 'thread', { id: 'draft-shell' })
  assert.deepEqual((await invoke('list', 'thread')).map(terminal => terminal.id), ['native-shell'])
  await assert.rejects(stream('attach', 'thread', { id: 'draft-shell' }), { code: 'terminal/unavailable' })
  await roster.return()
})

test('卸载 Codex 终端服务后结束其 shell 和订阅，原生路由仍可用', async t => {
  const { host, invoke, stream, nativeList } = await fixture(t)
  await invoke('create', 'thread', { request: terminalRequest('unload-shell') })
  const roster = (await stream('watch', 'thread'))[Symbol.asyncIterator]()
  await roster.next()

  async function* mark() {
    yield { type: 'write', sequence: 1, data: 'printf "owned-%s-shell\\n" "$$"\r', typed: true }
  }
  const attachment = (await stream('attach', 'thread', { id: 'unload-shell' }, { uplink: mark() }))[Symbol.asyncIterator]()
  let pid
  for (let output = ''; pid === undefined;) {
    const next = await attachment.next()
    assert.equal(next.done, false)
    if (next.value.type !== 'output') continue
    output += next.value.data
    const marker = /owned-(\d+)-shell/.exec(output)
    if (marker) pid = Number(marker[1])
  }
  await host.dispose()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal((await roster.next()).done, true)
  await attachment.return()
  await assert.rejects(invoke('list', 'thread'), { code: 'gateway/definition-unavailable' })
  assert.deepEqual(await nativeList('thread'), [])
})
