import { DisclosureRow, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import css from './thread-title-history.module.css'

const slot = 'conversation.chat.turnTail'
const locale = 'codex.thread-title-history'
const labels = {
  zh: {
    title: '标题自动更新', pending: '结果待确认', kept: '保留标题', 'not-applied': '结果未应用',
    renamed: '已更新标题', names: '{oldTitle} → {newTitle}', unnamed: '未命名',
  },
  en: {
    title: 'Automatic title update', pending: 'Result pending', kept: 'Title kept', 'not-applied': 'Result not applied',
    renamed: 'Title updated', names: '{oldTitle} → {newTitle}', unnamed: 'Untitled',
  },
}

function TitleHistoryRow({ update, t }) {
  const [open, setOpen] = useState(false)
  const renamed = update.outcome === 'renamed'
  const names = renamed ? t('names', { oldTitle: update.oldTitle ?? t('unnamed'), newTitle: update.newTitle }) : null
  const result = t(update.outcome)
  const title = renamed || update.outcome === 'kept' ? result : `${t('title')} · ${result}`
  return <DisclosureRow icon={<IconEditOutlineRegular />} title={title} rowClassName={css.row} titleClassName={css.title}
    open={open} expandable={renamed} expandOnRowClick onToggle={() => setOpen(value => !value)}>
    {renamed && <p className={css.details}>{names}</p>}
  </DisclosureRow>
}

function ThreadTitleHistory({ turn, useProjection, t }) {
  const turnId = turn.start?.data.codexTurnId
  const updates = useProjection('titleHistory', byTurn => byTurn?.get(turnId))
  return updates?.map((update, index) => <TitleHistoryRow key={index} update={update} t={t} />) ?? null
}

/** 用原生轮次尾部展示拟标题注记，不把注记写进 DSH 的对话事件流。 */
export function installThreadTitleHistory(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.slots.inject(slot, () => ctx.slots.register({
    name: slot, id: 'codex-thread-title-history', locale,
  }, ThreadTitleHistory))
}
