import {
  Button, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconDownloadOutlineRegular, MarkdownText, Tooltip, extractMarkdownPlainText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, useState } from 'react'
import { remoteFailure } from './catalog.js'
import { downloadMarkdown } from './session-export.jsx'
import { adaptSlot } from './slot-adapter.js'

const locale = 'codex.plan.document'
const protocol = 'codex-plan'
const labels = {
  zh: { title: '计划', open: '在侧栏打开', download: '下载 Markdown', unavailable: '无法读取这份计划。',
    loading: '正在读取计划…', copy: '复制', copied: '已复制', code: '代码', wrap: '换行', unwrap: '取消换行', footnotes: '脚注' },
  en: { title: 'Plan', open: 'Open in sidebar', download: 'Download Markdown', unavailable: 'This plan is unavailable.',
    loading: 'Loading plan…', copy: 'Copy', copied: 'Copied', code: 'Code', wrap: 'Wrap lines', unwrap: 'Unwrap lines', footnotes: 'Footnotes' },
}
const cardStyle = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-xl)', minWidth: 0 }
const barStyle = { display: 'flex', alignItems: 'center', gap: 4, padding: 6 }
const toggleStyle = { flex: 1, minWidth: 0, justifyContent: 'flex-start' }
const titleStyle = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const bodyStyle = { padding: '0 16px 12px', minWidth: 0 }
const paneStyle = { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '8px 16px 16px' }

function planAddress(threadId, turnId, itemId) {
  return `dsh-resource://${protocol}/${[threadId, turnId, itemId].map(encodeURIComponent).join('/')}`
}

function parseAddress(address) {
  const parts = /^dsh-resource:\/\/codex-plan\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(address)
  if (parts) try { return parts.slice(1).map(decodeURIComponent) } catch { /* 已保存的地址可能无效。 */ }
}

function planTitle(markdown, t) {
  return extractMarkdownPlainText(markdown, { mode: 'first-line' }).trim() || t('title')
}

function PlanMarkdown({ markdown, t }) {
  const copy = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: {
    codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'),
  } }, footnotes: t('footnotes') }), [t])
  return <MarkdownText text={markdown} labels={copy} textInteractionSource />
}

function PlanCard({ markdown, preview, openSidebar, t }) {
  const [open, setOpen] = useState(true)
  const title = planTitle(markdown, t)
  const Chevron = open ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular
  return <section data-codex-plan-document="" style={cardStyle} aria-label={title}>
    <div style={barStyle}>
      <Button size="sm" variant="ghost" style={toggleStyle} icon={<Chevron size={14} />}
        data-codex-plan-toggle="" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <FileTypeIcon kind="markdown" size={16} /><span style={titleStyle}>{title}</span>
      </Button>
      <Tooltip label={t('download')} side="top">
        <Button size="sm" variant="ghost" aria-label={t('download')} onClick={() => downloadMarkdown(markdown, title, '')}
          icon={<IconDownloadOutlineRegular size={16} />} />
      </Tooltip>
      <Button size="sm" variant="ghost" onClick={openSidebar}>{t('open')}</Button>
    </div>
    {open && <div style={bodyStyle}><PlanMarkdown markdown={preview} t={t} /></div>}
  </section>
}

function PlanTab({ useResource, useTabInfo, t }) {
  const { tab } = useTabInfo()
  const { status, value } = useResource(tab.navigation.address)
  return <section data-codex-plan-preview="" style={paneStyle} aria-label={value?.title ?? t('title')}>
    {value ? <>
      <Button size="sm" variant="ghost" icon={<IconDownloadOutlineRegular size={16} />}
        onClick={() => downloadMarkdown(value.markdown, value.title, '')}>{t('download')}</Button>
      <PlanMarkdown markdown={value.markdown} t={t} />
    </> : <p role="status">{t(status === 'loading' ? 'loading' : 'unavailable')}</p>}
  </section>
}

function PlanTabTitle({ useResource, useTabInfo }) {
  const { tab } = useTabInfo()
  const { value } = useResource(tab.navigation.address)
  return <><FileTypeIcon kind="markdown" size={16} />{value?.title ?? tab.title}</>
}

/** 计划正文保留原生消息锚点。侧栏按原生条目身份复用当前会话的分页读取。 */
export function installPlanDocuments(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.inject(['sessions', 'resources', 'sidebarRight', 'sidebarRightTabs'], scope => {
    scope.effect(() => scope.resources.register({
      protocol,
      async *open(address, { signal }) {
        try {
          const [threadId, turnId, itemId] = parseAddress(address) ?? []
          if (!threadId) throw new Error(t('unavailable'))
          const value = await scope.sessions.using(threadId, { source: protocol },
            async ({ binding }) => binding.session.readPlanMarkdown(turnId, itemId, signal))
          if (signal.aborted) return
          if (!value?.trim()) throw new Error(t('unavailable'))
          yield { ok: true, value: { title: planTitle(value, t), markdown: value } }
        } catch (error) {
          if (!signal.aborted) yield { ok: false, error: remoteFailure(error.message) }
        }
      },
    }))
    scope.effect(() => scope.sidebarRightTabs.register({ id: protocol, kind: protocol,
      patterns: [`dsh-resource://${protocol}/**`], canOpen: address => Boolean(parseAddress(address)), title: () => t('title') }))
    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab', key: protocol, locale }, PlanTab))
    scope.slots.inject('sidebar.right.pane.tab.title', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: protocol, locale }, PlanTabTitle))
    adaptSlot(scope, 'conversation.chat.node', entry => entry.options.key === 'assistant-step', (inject, Native) => ({
      inject(sessionId, ...args) {
        return { ...inject(sessionId, ...args), planSession: scope.sessions.binding(sessionId)?.session }
      },
      component({ planSession, ...props }) {
        const { node, groupPart, sessionId } = props
        const turnId = node.location.turn?.start?.data.codexTurnId
        const itemId = node.data.finalNode?.messageId
        const markdown = planSession?.planMarkdown(turnId, itemId)
        if (!markdown?.trim() || groupPart === 'reasoning') return <Native {...props} />
        const preview = node.data.blocks.find(block => block.kind === 'text')?.text ?? markdown
        return <PlanCard key={itemId} markdown={markdown} preview={preview} t={t}
          openSidebar={() => scope.sidebarRight.openResource(planAddress(sessionId, turnId, itemId))} />
      },
    }))
  })
}
