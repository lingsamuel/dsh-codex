import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

test('技能来源沿用 DSH 的触发菜单，按会话读取并只替换光标处的技能词', async t => {
  const previousDocument = globalThis.document
  globalThis.document = { baseURI: 'http://localhost/' }
  t.after(() => { globalThis.document = previousDocument })
  const requests = []
  const nativeTracks = []
  const menus = []
  let launched = null
  let source
  const controller = {
    track: (...args) => nativeTracks.push(args),
    launcher: { getSnapshot: () => launched, set: value => { launched = value } },
    toggleSource(name, hit) {
      if (launched !== name) menus.push([name, hit])
      launched = name
    },
  }
  const nativeTrack = controller.track
  const sessionOf = () => controller
  const inputTriggers = {
    sessionOf,
    registerSource(candidateSource) {
      source = candidateSource
      return () => { source = undefined }
    },
  }
  const sessions = {
    binding: id => ({ session: { getSnapshot: () => ({ localDraft: id === 'draft-local' }) } }),
    list: { getSnapshot: () => ({ byId: { 'draft-local': { cwd: '/workspace' } } }) },
  }
  const scope = { inputTriggers, sessions, effect: effect => effect() }
  const ctx = { inject: (_keys, install) => install(scope) }
  const actx = { effect: effect => effect() }
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), signal })
    return Response.json({ skills: [{ name: 'review', label: 'Code review', description: 'Inspect code' },
      { name: 'draft', description: 'Draft a report' }] })
  })

  const { installCodexSkills } = await import('../src/client/native-dsh/skills.js')
  const dispose = installCodexSkills(ctx)
  assert.equal(inputTriggers.sessionOf(actx), controller)
  assert.equal(source.trigger, '$')
  const guard = { tier: 'plain' }
  const draft = '请 $review 然后继续'
  controller.track(draft, 5, guard, 4)
  controller.track(draft, 5, guard, 4)
  assert.deepEqual(menus, [['skill', { trigger: '$', query: 're', quoted: false, position: 'inline',
    span: { start: 2, end: 9, draftRev: 4 } }]])
  assert.equal(launched, null)
  const signal = new AbortController().signal
  const found = await source.candidates({ sessionId: 'old-session' }, { query: 'CODE', signal })
  assert.deepEqual(found, [{ name: 'review', label: 'Code review', description: 'Inspect code' }])
  assert.deepEqual(await source.candidates({ sessionId: 'draft-local' }, { query: 'CODE', signal }), found)
  assert.deepEqual(requests, [
    { path: '/api/codex/skills', query: { threadId: 'old-session' }, signal },
    { path: '/api/codex/skills', query: { cwd: '/workspace' }, signal },
  ])
  assert.deepEqual(source.onPick({ candidate: found[0] }), { text: '$review ' })

  controller.track('/goal', 5, guard, 5)
  controller.track('@file', 5, guard, 6)
  controller.track('$draft', 6, { tier: 'frozen' }, 7)
  assert.deepEqual(nativeTracks.map(([text]) => text), ['/goal', '@file', '$draft'])
  assert.equal(menus.length, 1)
  dispose()
  assert.equal(source, undefined)
  assert.equal(inputTriggers.sessionOf, sessionOf)
  assert.equal(controller.track, nativeTrack)
})

test('Host 为草稿按工作目录读取启用的技能，不启动或读取会话', async t => {
  const { createSkillsRoute } = await import('../src/host/skills.mjs')
  const directory = await mkdtemp(join(process.cwd(), '.runtime', 'draft-skill-'))
  const socket = join(directory, 'api.sock')
  const server = createServer()
  const ws = new WebSocketServer({ server })
  const calls = []
  ws.on('connection', client => client.on('message', raw => {
    const { id, method, params } = JSON.parse(raw)
    if (id === undefined) return
    if (method !== 'initialize') calls.push([method, params])
    const result = method === 'initialize' ? {} : { data: [{ cwd: directory, skills: [
      { name: 'review', path: '/skills/review/SKILL.md', enabled: true },
      { name: 'hidden', path: '/skills/hidden/SKILL.md', enabled: false },
    ] }] }
    client.send(JSON.stringify({ id, result }))
  }))
  server.listen(socket)
  await once(server, 'listening')
  t.after(async () => {
    for (const client of ws.clients) client.terminate()
    ws.close()
    const closed = once(server, 'close')
    server.close()
    await closed
    await rm(directory, { recursive: true, force: true })
  })
  const route = createSkillsRoute(socket)
  const get = cwd => route.fetch(new Request(`http://local${route.path}?${new URLSearchParams({ cwd })}`))
  const response = await get(directory)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { skills: [{ name: 'review', path: '/skills/review/SKILL.md' }] })
  assert.equal((await get('relative/path')).status, 400)
  assert.deepEqual(calls, [['skills/list', { cwds: [directory] }]])
})
