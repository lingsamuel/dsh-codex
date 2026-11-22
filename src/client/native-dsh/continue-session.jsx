import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

const locale = 'codex.session.continue'
const slot = 'conversation.session.header.utilities'
const labels = {
  zh: { resume: '继续会话', pending: '正在加载…' },
  en: { resume: 'Resume session', pending: 'Loading…' },
}

function ContinueSession({ sessionId, useSession, resume, t }) {
  const canResume = useSession(({ live, archived, subagent }) =>
    live.status?.type === 'notLoaded' && !archived && !subagent)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  if (!canResume) return null

  async function open() {
    setError('')
    setPending(true)
    try {
      const result = await resume(sessionId)
      if (result && !result.ok) setError(result.error.message)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending(false)
    }
  }

  return <>
    <Button size="sm" variant="outline" disabled={pending} onClick={open}>{t(pending ? 'pending' : 'resume')}</Button>
    {error && <span role="alert">{error}</span>}
  </>
}

/** 仅显式继续时加载原生历史线程，浏览历史不建立控制订阅。 */
export function installContinueSession(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['sessions'], scope => {
    scope.slots.inject(slot, () => scope.slots.register({ name: slot, id: 'codex-continue-session', order: 10, locale,
      inject: () => ({ resume: id => scope.sessions.binding(id)?.session.resume() }),
    }, ContinueSession))
  })
}
