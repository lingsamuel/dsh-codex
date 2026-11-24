import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { adaptSlot } from './slot-adapter.js'

const locale = 'codex.history.details'
const tail = 'conversation.chat.turnTail'
const flow = 'conversation.chat.flow'
const labels = {
  zh: { load: '加载本轮详情', loading: '正在加载本轮详情…', error: '无法加载本轮详情。', retry: '重试加载本轮详情' },
  en: { load: 'Load turn details', loading: 'Loading turn details…', error: 'Could not load turn details.', retry: 'Retry loading turn details' },
}
const rowStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
const statusStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)' }

function HistoryDetails({ turnId, historySession, useProjection, t }) {
  const details = useProjection('historyDetails', state => state?.[turnId])
  if (!turnId || !details || !historySession?.loadHistoryDetails) return null
  const { loading, error } = details

  async function load() {
    if (loading) return
    try { await historySession.loadHistoryDetails(turnId) }
    catch { /* 会话投影负责呈现当前轮次仍有效的读取错误。 */ }
  }

  return <div data-codex-history-details="" style={rowStyle}>
    <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={load}>{t(error ? 'retry' : 'load')}</Button>
    <span role="status" style={statusStyle}>{loading ? t('loading') : error ? t('error') : ''}</span>
  </div>
}

function openTurnId({ timeline }) {
  const turn = timeline.turns.get(timeline.turnOrder.at(-1))
  return turn?.status === 'open' ? turn.start?.data.codexTurnId : undefined
}

/** 在摘要所属的轮次显示分页详情入口。会话负责合并原生条目和取消失效的读取。 */
export function installHistoryDetails(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['sessions'], scope => {
    const t = scope.locale.bind(locale)
    const injectSession = sessionId => ({ historySession: scope.sessions.binding(sessionId)?.session })
    scope.slots.inject(tail, () => scope.slots.register({ name: tail, id: 'codex-history-details', locale, inject: injectSession },
      ({ turn, ...props }) => <HistoryDetails {...props} turnId={turn.start?.data.codexTurnId} />))

    // 原生轮次尾部在 turn/end 才出现。进行中的摘要借用聊天流尾部，结束后由原生插槽接管。
    adaptSlot(scope, flow, () => true, (inject, Native) => ({
      inject: (sessionId, ...args) => ({ ...inject(sessionId, ...args), ...injectSession(sessionId) }),
      component({ historySession, ...props }) {
        const turnId = props.useChat(openTurnId)
        return <>
          <Native {...props} />
          {turnId && <HistoryDetails turnId={turnId} historySession={historySession} useProjection={props.useProjection} t={t} />}
        </>
      },
    }))
  })
}
