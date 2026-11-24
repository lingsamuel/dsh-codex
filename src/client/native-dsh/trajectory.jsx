import { useCallback, useSyncExternalStore } from 'react'
import { TrajectoryView } from '@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryView.tsx'
import { trajectoryTurnNumber } from '../native-chat/trajectory.js'
import { adaptSlot } from './slot-adapter.js'

const locale = 'codex.trajectory'
const labels = {
  zh: { loaded: '已加载第 {turn} 轮', loadedShort: '已加载 #{turn}', unknown: '轮次未知' },
  en: { loaded: 'Loaded turn {turn}', loadedShort: 'Loaded #{turn}', unknown: 'Unknown turn' },
}

function CodexTrajectory({ eventSource, label, native: Native, t, ...props }) {
  const window = useSyncExternalStore(eventSource.subscribe, eventSource.getSnapshot)
  const coordinates = window.readCodexTrajectory?.()
  const firstTurn = coordinates?.firstTurn
  const { hasMore } = window
  const labelTurn = useCallback(turn => {
    const number = trajectoryTurnNumber(firstTurn, turn)
    if (number === undefined) return { title: label('unknown'), compact: '—' }
    if (hasMore) return { title: label('loaded', { turn: number }), compact: label('loadedShort', { turn: number }) }
    return { title: t('turn.label', { turn: number }), compact: `#${number}` }
  }, [firstTurn, hasMore, label, t])
  return coordinates
    ? <TrajectoryView {...props} t={t} locateTool={coordinates.locateTool} labelTurn={labelTurn} />
    : <Native {...props} t={t} />
}

/** 复用 DSH 的轨迹注册与检查器，在 Codex 页面提供原生事件坐标。 */
export function installTrajectory(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const label = ctx.locale.bind(locale)
  ctx.inject(['sessions'], scope => adaptSlot(scope, 'conversation.view', entry => entry.options.id === 'trajectory',
    (inject, Native) => ({
      inject: (sessionId, ...args) => ({
        ...inject(sessionId, ...args), codexEventSource: scope.sessions.binding(sessionId)?.eventSource,
      }),
      component: ({ codexEventSource, ...props }) => codexEventSource
        ? <CodexTrajectory {...props} eventSource={codexEventSource} label={label} native={Native} />
        : <Native {...props} />,
    })))
}
