import { Button, IconCodeOutlineRegular, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { writeThreadAction } from '../api.js'

const locale = 'codex.backgroundTerminals'
const labels = {
  zh: {
    title: '后台任务', running: '{count} 个后台进程运行中', stop: '停止', stopCommand: '停止后台命令 {command}',
    confirm: '确认停止', stopping: '正在停止…',
  },
  en: {
    title: 'Background tasks', running: 'Running background processes: {count}', stop: 'Stop', stopCommand: 'Stop background command {command}',
    confirm: 'Confirm stop', stopping: 'Stopping…',
  },
}

const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }

function RunningCount({ sessionId, useBackgroundTerminals, t }) {
  const count = useBackgroundTerminals(state => state.get(sessionId)?.length ?? 0)
  return count > 0 && <span>{t('running', { count })}</span>
}

function SidebarTerminalIcon({ sessionId, useBackgroundTerminals, t }) {
  const count = useBackgroundTerminals(state => state.get(sessionId)?.length ?? 0)
  return count > 0 && <span style={{ display: 'inline-flex' }}>
    <IconCodeOutlineRegular size={14} aria-hidden />
    <span style={visuallyHidden}>{t('running', { count })}</span>
  </span>
}

function PanelIndicator({ sessionId, panelShown, useBackgroundTerminals, t }) {
  const count = useBackgroundTerminals(state => state.get(sessionId)?.length ?? 0)
  return !panelShown && count > 0 && <span style={{ background: 'var(--dsw-alias-state-business-primary)' }}>
    <span style={visuallyHidden}>{t('running', { count })}</span>
  </span>
}

function TerminalRow({ terminal, sessionId, t }) {
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  useEffect(() => {
    if (phase !== 'confirm') return
    const timeout = setTimeout(() => setPhase('idle'), 3000)
    return () => clearTimeout(timeout)
  }, [phase])

  async function pressStop() {
    if (phase === 'idle') {
      setError('')
      setPhase('confirm')
      return
    }
    setPhase('stopping')
    try {
      await writeThreadAction({ action: 'terminate-background-terminal', threadId: sessionId, processId: terminal.processId })
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPhase('idle')
    }
  }

  return <div>
    <div data-session-panel-row="">
      <span data-row-part="body">
        <span data-row-part="icon" aria-hidden><IconCodeOutlineRegular size={16} /></span>
        <span data-row-part="lines">
          <code data-row-part="content" title={terminal.command}>{terminal.command}</code>
          {terminal.cwd && <span data-row-part="detail"><PathLabel path={terminal.cwd} /></span>}
        </span>
      </span>
      <Button data-row-part="trailing" size="sm" variant="outline" onClick={pressStop} disabled={phase === 'stopping'}
        aria-label={phase === 'idle' ? t('stopCommand', { command: terminal.command }) : t(phase)}>
        {t(phase === 'idle' ? 'stop' : phase)}
      </Button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>
}

function BackgroundTerminalSection({ sessionId, useBackgroundTerminals, t }) {
  const terminals = useBackgroundTerminals(state => state.get(sessionId))
  return terminals?.map(terminal => <TerminalRow key={`${sessionId}:${terminal.processId}`} {...{ terminal, sessionId, t }} />)
}

/** 共用目录流中的原生进程快照。侧栏的行只读取自己的线程。 */
export function installBackgroundTerminals(ctx, backgroundTerminals) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  const slots = [
    ['sidebar.session.row.trailing', SidebarTerminalIcon],
    ['sidebar.session.row.hover', RunningCount],
    ['conversation.session.panel.indicator', PanelIndicator, { order: 20 }],
    ['conversation.session.panel.section', BackgroundTerminalSection, { order: 300, label: () => t('title') }],
  ]
  for (const [name, Component, options] of slots) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'codex-background-terminals', locale,
      ...options, inject: () => ({ hooks: { backgroundTerminals } }),
    }, Component))
  }
}
