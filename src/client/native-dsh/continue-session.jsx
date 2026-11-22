import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

const locale = 'codex.session.continue'
const slot = 'conversation.input.overlay'
const labels = {
  zh: { resume: '点击继续会话', pending: '正在加载…' },
  en: { resume: 'Click to resume', pending: 'Loading…' },
}

const overlayStyles = `
[data-codex-resume-overlay] {
  position: absolute;
  inset: 6px 8px auto;
  z-index: 1;
  display: grid;
  min-height: 36px;
  place-items: center;
  border-radius: var(--dsw-radius-panel);
  background: var(--dsw-specific-input-major);
  pointer-events: none;
}
[data-codex-resume-overlay] button { pointer-events: auto; }
[data-codex-resume-overlay] [role="alert"] {
  position: absolute;
  inset: auto 0 calc(100% + 10px);
  padding: 8px 12px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-elevation-soft);
}
@media (hover: hover) {
  [data-composer-card]:not(:hover) [data-codex-resume-overlay]:not(:focus-within):not([data-feedback]) {
    opacity: 0;
  }
  [data-composer-card]:not(:hover) [data-codex-resume-overlay]:not(:focus-within):not([data-feedback]) button {
    pointer-events: none;
  }
}
`

function ContinueSession({ sessionId, useSession, resume, t }) {
  const canResume = useSession(({ live, archived, subagent, canAcceptDirectInput }) =>
    live.status?.type === 'notLoaded' && !archived && !subagent && canAcceptDirectInput !== false)
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

  return <div data-codex-resume-overlay data-feedback={Boolean(pending || error) || undefined}>
    <Button size="sm" variant="primary" disabled={pending} onClick={open}>{t(pending ? 'pending' : 'resume')}</Button>
    {error && <span role="alert">{error}</span>}
  </div>
}

/** 仅显式继续时加载原生历史线程，浏览历史不建立控制订阅。 */
export function installContinueSession(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = overlayStyles
    document.head.append(style)
    return () => style.remove()
  })
  ctx.inject(['sessions'], scope => {
    scope.slots.inject(slot, () => scope.slots.register({ name: slot, id: 'codex-continue-session', order: 10, locale,
      inject: () => ({ resume: id => scope.sessions.binding(id)?.session.resume() }),
    }, ContinueSession))
  })
}
