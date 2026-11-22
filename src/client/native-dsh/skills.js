import { readPage } from '../api.js'
import { sessionReadScope } from './catalog.js'

function skillHit(draft, caret, draftRev) {
  const match = /(?<![\p{L}\p{M}\p{N}_$\\])\$([\p{L}\p{M}\p{N}_:-]*)$/u.exec(draft.slice(0, caret))
  if (!match) return
  const start = match.index
  const end = caret + draft.slice(caret).match(/^[\p{L}\p{M}\p{N}_:-]*/u)[0].length
  return {
    trigger: '$', query: match[1], quoted: false, position: draft.search(/\S/) === start ? 'leading' : 'inline',
    span: { start, end, draftRev },
  }
}

/** 将 Codex 的 $ 输入交给 DSH 原生候选菜单和编辑器选取流程。 */
export function installCodexSkills(ctx) {
  return ctx.inject(['inputTriggers', 'sessions'], scope => scope.effect(() => {
    const triggers = scope.inputTriggers
    const source = {
      trigger: '$',
      name: 'skill',
      async candidates({ sessionId }, { query, signal }) {
        const target = sessionReadScope(scope.sessions, sessionId)
        if (!target) return []
        const { skills } = await readPage('skills', target, signal)
        const search = query.toLowerCase()
        return skills.filter(({ name, label }) => name.toLowerCase().includes(search) || label?.toLowerCase().includes(search))
      },
      onPick({ candidate }) {
        // 选择和手输使用同一可编辑文本。发送时由 Host 根据当前目录查找原生技能。
        return { text: `$${candidate.name} ` }
      },
    }
    const unregister = triggers.registerSource(source)
    const sessionOf = triggers.sessionOf
    const controllers = new Map()
    function withSkillTrigger(actx) {
      const controller = sessionOf.call(this, actx)
      if (controllers.has(controller)) return controller
      const track = controller.track
      let previousHit
      function trackSkills(draft, caret, guard, draftRev) {
        if (guard.tier === 'frozen') return track.call(this, draft, caret, guard, draftRev)
        const hit = skillHit(draft, caret, draftRev)
        if (!hit) {
          previousHit = undefined
          return track.call(this, draft, caret, guard, draftRev)
        }
        if (previousHit?.query === hit.query && previousHit.span.start === hit.span.start
          && previousHit.span.end === hit.span.end && previousHit.span.draftRev === draftRev) return
        previousHit = hit
        // 当前 DSH 的输入检测仅识别 / 和 @。复用控制器的原生菜单入口和选区校验。
        this.toggleSource(source.name, hit)
        this.launcher.set(null)
      }
      const restore = () => {
        if (controller.track === trackSkills) controller.track = track
        controllers.delete(controller)
      }
      controller.track = trackSkills
      controllers.set(controller, restore)
      actx.effect(() => restore)
      return controller
    }
    triggers.sessionOf = withSkillTrigger
    return () => {
      if (triggers.sessionOf === withSkillTrigger) triggers.sessionOf = sessionOf
      for (const restore of controllers.values()) restore()
      unregister()
    }
  }))
}
