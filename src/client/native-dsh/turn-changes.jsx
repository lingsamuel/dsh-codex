import {
  Button, CodeBlock, DiffBlock, DisclosureRow, FileTypeIcon,
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconEditOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { codexTurnChanges } from '../native-chat/turn-changes.js'

const locale = 'codex.turn.changes'
const slot = 'conversation.chat.turnTail'
const initiallyVisibleFiles = 4
const stackStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.5rem' }
const labels = {
  zh: { files: '{count} 个文件有改动', showAllFiles: '显示全部 {count} 个文件', collapseFiles: '收起文件列表',
    code: '补丁', wrap: '换行', unwrap: '取消换行', copy: '复制', copied: '已复制', collapse: '收起', expand: '展开 {count} 行' },
  en: { files: '{count} files changed', showAllFiles: 'Show all {count} files', collapseFiles: 'Collapse file list',
    code: 'Patch', wrap: 'Wrap lines', unwrap: 'Unwrap lines', copy: 'Copy', copied: 'Copied', collapse: 'Collapse', expand: 'Show {count} lines' },
}

function FileDiffs({ file, copy }) {
  return <div style={stackStyle}>
    {file.edits.map(({ diffs, raw }, index) => raw === undefined
      ? <DiffBlock key={index} diffs={diffs} labels={copy} />
      : <figure key={index} style={{ margin: 0 }}>
        <figcaption style={{ overflowWrap: 'anywhere', font: 'var(--dsw-font-markdown-code-block-small)' }}>{file.path}</figcaption>
        <CodeBlock code={raw} lang="diff" toolbarLabels={copy} copyLabel={copy.copy} copiedLabel={copy.copied} />
      </figure>)}
  </div>
}

function ChangedFileList({ files, copy, t }) {
  const [showAll, setShowAll] = useState(false)
  const [selectedPath, setSelectedPath] = useState(null)
  const visibleFiles = showAll ? files : files.slice(0, initiallyVisibleFiles)
  const Chevron = showAll ? IconChevronUpOutlineRegular : IconChevronDownOutlineRegular

  function toggleList() {
    // 收起列表时解除被折叠文件的选择，重新展开只显示文件行。
    if (showAll && files.findIndex(file => file.path === selectedPath) >= initiallyVisibleFiles) setSelectedPath(null)
    setShowAll(!showAll)
  }

  return <div style={stackStyle}>
    {visibleFiles.map(file => {
      const selected = file.path === selectedPath
      return <DisclosureRow key={file.path} icon={<FileTypeIcon path={file.path} size={16} />} title={file.path}
        open={selected} expandable expandOnRowClick onToggle={() => setSelectedPath(selected ? null : file.path)}>
        {selected && <FileDiffs file={file} copy={copy} />}
      </DisclosureRow>
    })}
    {files.length > initiallyVisibleFiles && <Button size="sm" variant="ghost" aria-expanded={showAll} onClick={toggleList}
      style={{ justifySelf: 'start', color: 'var(--dsw-alias-label-tertiary)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
        {showAll ? t('collapseFiles') : t('showAllFiles', { count: files.length })}
        <Chevron size={14} />
      </span>
    </Button>}
  </div>
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
    {open && (files.length === 1
      ? <FileDiffs file={files[0]} copy={copy} />
      : <ChangedFileList files={files} copy={copy} t={t} />)}
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
