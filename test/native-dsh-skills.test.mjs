import assert from 'node:assert/strict'
import { test } from 'node:test'

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
  const scope = { inputTriggers, effect: effect => effect() }
  const ctx = { inject: (keys, install) => {
    assert.deepEqual(keys, ['inputTriggers'])
    return install(scope)
  } }
  const actx = { effect: effect => effect() }
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    requests.push({ path: url.pathname, threadId: url.searchParams.get('threadId'), signal })
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
  assert.deepEqual(requests, [{ path: '/api/codex/skills', threadId: 'old-session', signal }])
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
