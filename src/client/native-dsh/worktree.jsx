import {
  Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
  IconFolderCloseRegular, Menu, Modal, PathLabel,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { abbreviateHomePath, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import { useEffect, useRef, useState } from 'react'
import { readPage, writeWorktreeAction } from '../api.js'

const locale = 'codex.worktrees'
const labels = {
  zh: {
    title: '工作目录', local: '本地目录', worktree: '工作树', new: '新建工作树', existing: '已有工作树', recover: '打开目标会话',
    loading: '正在读取 Git 工作树…', noRepository: '此目录没有 Git 工作树。',
    base: '基准分支', back: '返回工作目录',
    detached: '分离 HEAD · {commit}',
    switch: '切换工作目录', select: '使用此目录', cancel: '取消',
    active: '请先结束当前轮次，再切换工作目录。', queue: '请先发送或移除待发消息，再切换工作目录。',
    background: '请先结束后台进程，再切换工作目录。',
  },
  en: {
    title: 'Working directory', local: 'Local directory', worktree: 'Worktree', new: 'New worktree', existing: 'Existing worktree', recover: 'Open target session',
    loading: 'Reading Git worktrees…', noRepository: 'This directory has no Git worktrees.',
    base: 'Base branch', back: 'Back to working directories',
    detached: 'Detached HEAD · {commit}',
    switch: 'Switch working directory', select: 'Use directory', cancel: 'Cancel',
    active: 'Finish the active turn before switching directories.', queue: 'Send or remove queued messages before switching directories.',
    background: 'Stop background processes before switching directories.',
  },
}
const menuPathStyle = { maxWidth: 'min(64vw, 18rem)' }
// 输入栏的工作树操作沿用 DSH 权限与模型控件的文字规格。
const composerTriggerStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, fontWeight: 500, lineHeight: '20px' }
const triggerLabelStyle = { maxWidth: 'min(36vw, 16rem)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function SwitchDirectory({ thread, path, shownPath, name, idleBlock, publishThread, close, t }) {
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState(false)

  async function confirm() {
    setSwitching(true)
    setError('')
    try {
      publishThread(await writeWorktreeAction({ threadId: thread.id, cwd: path, expectedCwd: thread.cwd }))
      close()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setSwitching(false)
    }
  }

  return <Modal open title={t('switch')} onClose={() => { if (!switching) close() }} closeLabel={t('cancel')}
    footer={<>
      <Button variant="outline" disabled={switching} onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" disabled={switching || Boolean(idleBlock)} onClick={confirm}>{t('select')}</Button>
    </>}>
    {name && <div>{name}</div>}
    <div title={shownPath} style={{ overflowWrap: 'anywhere' }}>{shownPath}</div>
    {idleBlock && <p role="status">{t(idleBlock)}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

function directoryLabel(path, label) {
  return <>
    {label}
    <PathLabel path={path} style={menuPathStyle} />
  </>
}

function checkoutName(checkout, t) {
  return checkout?.branchLabel ?? (checkout?.head && t('detached', { commit: checkout.head.slice(0, 7) }))
}

function WorktreePicker({ thread, draft, choice, project, home, idleBlock, setDraft, publishThread, openWorktree, disabled, t }) {
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState(undefined)
  const [error, setError] = useState('')
  const [destination, setDestination] = useState(null)
  const trigger = useRef(null)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const { signal } = controller
    readPage('worktrees', { cwd: thread.cwd }, signal).then(value => {
      if (!signal.aborted) setChoices(value)
    }, failure => {
      if (!signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [open, thread.cwd])

  const formatPath = path => abbreviateHomePath(relativizeToCwd(path, project ?? thread.cwd), home)
  const checkouts = choices ? [choices.local, ...choices.worktrees].filter(Boolean) : []
  const current = checkoutName(checkouts.find(tree => tree.path === thread.cwd), t)
  const localLabel = name => name ? `${t('local')} · ${name}` : t('local')
  const local = {
    id: 'local', icon: <IconFolderCloseRegular size={14} />,
    label: directoryLabel(formatPath(thread.cwd), localLabel(current)),
  }
  const entries = draft ? [local] : []
  if (choices) {
    const worktrees = choices.worktrees.map(tree => ({
      id: tree.path,
      label: directoryLabel(formatPath(tree.path), checkoutName(tree, t) ?? t('worktree')),
      icon: draft && choice?.path === tree.path ? <IconCheckOutlineRegular size={14} /> : <IconBranchOutlineRegular size={14} />,
      disabled: tree.path === thread.cwd || (!draft && Boolean(idleBlock)),
    }))
    if (draft) {
      const branches = choices.branches.map(({ ref, label }) => ({
        id: ref, label,
        icon: choice?.baseRef === ref ? <IconCheckOutlineRegular size={14} /> : <IconBranchOutlineRegular size={14} />,
      }))
      entries.push({
        id: 'new', label: t('new'), icon: <IconBranchOutlineRegular size={14} />, disabled: branches.length === 0,
        submenu: [{ type: 'label', id: 'base', text: t('base') }, ...branches],
      }, {
        id: 'existing', label: t('existing'), icon: <IconBranchOutlineRegular size={14} />,
        disabled: !worktrees.some(tree => !tree.disabled), submenu: worktrees,
      })
    } else {
      if (choices.local) entries.push({
        ...local, id: choices.local.path, label: directoryLabel(formatPath(choices.local.path), localLabel(checkoutName(choices.local, t))),
        disabled: choices.local.path === thread.cwd || Boolean(idleBlock),
      })
      entries.push(...worktrees)
    }
  }
  const status = error || (choices === undefined ? t('loading') : choices === null ? t('noRepository') : '')
  if (status) entries.push({ type: 'label', id: 'status', text: status })
  if (idleBlock) entries.unshift({ type: 'label', id: 'blocked', text: t(idleBlock) })

  function select(id) {
    setOpen(false)
    if (!draft) {
      if (!idleBlock) {
        // 菜单项随弹窗打开而卸载，让原生弹窗记住仍在页面上的返回焦点。
        trigger.current?.focus({ preventScroll: true })
        setDestination(id)
      }
      return
    }
    if (id === 'local') {
      if (choice) setDraft(undefined)
    } else {
      // 保存显示所需的 Git 信息，以便返回草稿时立即看到选中的分支。发送仍使用原生引用和路径。
      const branch = choices?.branches.find(item => item.ref === id)
      if (branch) {
        if (choice?.baseRef !== id) setDraft({ kind: 'new', baseRef: id, branchLabel: branch.label, id: randomUUID() })
      } else if (choice?.path !== id) {
        const tree = choices?.worktrees.find(item => item.path === id)
        if (tree) setDraft({ kind: 'existing', path: id, branchLabel: tree.branchLabel, head: tree.head, id: randomUUID() })
      }
    }
  }

  const label = t(draft ? choice?.kind ?? 'local' : 'title')
  const choiceName = draft && checkoutName(checkouts.find(tree => tree.path === choice?.path) ?? choice, t)
  const triggerLabel = choiceName ? `${label} · ${choiceName}` : label
  const tooltip = draft && choice?.kind === 'new' ? choiceName : formatPath((draft && choice?.path) || thread.cwd)
  const target = destination && checkouts.find(tree => tree.path === destination)
  return <>
    <Menu open={open} portal autoFocus dense maxVisibleRows={8} side="top"
      items={entries} selectedId={draft ? choice?.kind ?? 'local' : thread.cwd} submenuBackLabel={t('back')}
      onClose={() => setOpen(false)} onSelect={select}
      anchor={<Button ref={trigger} size="sm" variant="ghost" aria-haspopup="menu" aria-expanded={open}
        style={composerTriggerStyle} title={tooltip} disabled={disabled} onClick={() => {
          if (!open) {
            setChoices(undefined)
            setError('')
          }
          setOpen(!open)
        }}>
        <span style={triggerLabelStyle}>{triggerLabel}</span><IconChevronDownOutlineRegular size={12} aria-hidden="true" />
      </Button>} />
    {draft && choice?.recovery && <Button size="sm" variant="ghost" style={composerTriggerStyle} disabled={disabled}
      title={formatPath(choice.recovery.thread.cwd)} onClick={() => openWorktree(choice.recovery, false)}>{t('recover')}</Button>}
    {destination && <SwitchDirectory {...{ thread, idleBlock, publishThread, t }}
      path={destination} shownPath={formatPath(destination)} name={checkoutName(target, t)}
      close={() => setDestination(null)} />}
  </>
}

function WorktreeButton({ sessionId, useSession, useProjection, useWorktreeDraft, useCodexHistory, useSessions, useWorkspaces, useHost,
  useBackgroundTerminals, setDraft, publishThread, openWorktree, t }) {
  const choice = useWorktreeDraft(value => value)
  const native = useCodexHistory(snapshot => snapshot.threads.find(value => value.id === sessionId))
  const project = useWorkspaces(snapshot => snapshot.items.find(item => item.sessionIds.includes(sessionId))?.path)
  const home = useHost(facts => facts?.home)
  const draft = useSession(state => Boolean(state.blank))
  const local = useSession(state => Boolean(state.localDraft))
  const cwd = useSessions(snapshot => snapshot.byId[sessionId]?.cwd)
  const thread = native ?? (local ? { id: sessionId, cwd } : undefined)
  const canChange = useSession(state => state.openState === 'open' && !state.archived && !state.subagent && state.canAcceptDirectInput !== false)
  const active = useSession(state => state.live?.status?.type === 'active' || Boolean(state.pendingSubmissions?.length))
  const queued = useProjection('inbox', inbox => Boolean(inbox?.['next-turn']?.length))
  const background = useBackgroundTerminals(value => Boolean(value.get(sessionId)?.length))
  if (!thread?.cwd || !canChange) return null
  const idleBlock = active ? 'active' : queued ? 'queue' : background ? 'background' : undefined
  return <WorktreePicker key={JSON.stringify([sessionId, thread.cwd, draft])}
    {...{ thread, draft, choice, project, home, setDraft, publishThread, openWorktree, t }}
    idleBlock={draft ? undefined : idleBlock} disabled={draft && active} />
}

/** 输入栏为新会话保存启动目录，为已有会话发起目录切换确认。 */
export function installWorktrees(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['sessions', 'remote'], scope => {
    const host = { getSnapshot: () => scope.remote.$host, subscribe: listener => scope.on('connection/reset', listener) }
    const name = 'conversation.input.left'
    ctx.slots.inject(name, () => ctx.slots.register({
      name, id: 'codex-worktrees', order: 30, locale,
      inject: sessionId => {
        const { worktreeDraft, openWorktree } = scope.sessions.binding(sessionId).session
        return { openWorktree, setDraft: worktreeDraft.set, hooks: { worktreeDraft, host, backgroundTerminals: catalog.backgroundTerminals },
          publishThread: ({ thread, workspacePaths }) => catalog.acceptThread(thread, workspacePaths),
        }
      },
    }, WorktreeButton))
  })
}
