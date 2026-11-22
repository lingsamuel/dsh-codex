import { CodeBlock, DiffBlock, DisclosureRow, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { codexTurnChanges } from '../native-chat/turn-changes.js'

const locale = 'codex.turn.changes'
const slot = 'conversation.chat.turnTail'
const labels = {
  zh: { files: '{count} 个文件有改动', code: '补丁', wrap: '换行', unwrap: '取消换行', copy: '复制', copied: '已复制', collapse: '收起', expand: '展开 {count} 行' },
  en: { files: '{count} files changed', code: 'Patch', wrap: 'Wrap lines', unwrap: 'Unwrap lines', copy: 'Copy', copied: 'Copied', collapse: 'Collapse', expand: 'Show {count} lines' },
}

function TurnChanges({ turn, t }) {
  const [open, setOpen] = useState(false)
  const files = turn.data.get(codexTurnChanges.kind)
  if (!files?.length) return null
  const copy = {
    codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'), copy: t('copy'), copied: t('copied'),
    collapse: t('collapse'), collapseAria: t('collapse'), expand: count => t('expand', { count }),
    expandAria: count => t('expand', { count }),
  }
  return <DisclosureRow icon={<IconEditOutlineRegular />} title={t('files', { count: files.length })}
    open={open} expandable expandOnRowClick onToggle={() => setOpen(value => !value)}>
    {open && files.map(file => <details key={file.path}>
      <summary>{file.path}</summary>
      {file.edits.map(({ diffs, raw }, index) => raw === undefined
        ? <DiffBlock key={index} diffs={diffs} labels={copy} />
        : <CodeBlock key={index} code={raw} lang="diff" toolbarLabels={copy} copyLabel={copy.copy} copiedLabel={copy.copied} />)}
    </details>)}
  </DisclosureRow>
}

/** 在 DSH 原生轮次尾部复用文件差异组件。 */
export function installTurnChanges(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['uiConversation'], scope => {
    scope.uiConversation.events.register(codexTurnChanges)
    scope.slots.inject(slot, () => scope.slots.register({ name: slot, id: 'codex-file-changes', locale }, TurnChanges))
  })
}
