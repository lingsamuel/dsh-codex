import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { readPage, writeWorktreeAction } from '../api.js'

const locale = 'codex.worktrees'
const labels = {
  zh: {
    title: '工作目录', local: '本地目录', worktree: '工作树', new: '新建工作树', existing: '已有工作树',
    loading: '正在读取 Git 工作树…', noRepository: '此目录没有 Git 工作树。',
    base: '基准分支', target: '工作树目录', begin: '发送首条消息时启动所选工作树会话。',
    switch: '切换工作目录', select: '使用此目录', cancel: '取消',
    active: '请先结束当前轮次，再切换工作目录。', queue: '请先发送或移除待发消息，再切换工作目录。',
    background: '请先结束后台进程，再切换工作目录。',
  },
  en: {
    title: 'Working directory', local: 'Local directory', worktree: 'Worktree', new: 'New worktree', existing: 'Existing worktree',
    loading: 'Reading Git worktrees…', noRepository: 'This directory has no Git worktrees.',
    base: 'Base branch', target: 'Worktree directory', begin: 'The first message starts the session in the selected worktree.',
    switch: 'Switch working directory', select: 'Use directory', cancel: 'Cancel',
    active: 'Finish the active turn before switching directories.', queue: 'Send or remove queued messages before switching directories.',
    background: 'Stop background processes before switching directories.',
  },
}
const fieldStyle = { display: 'grid', gap: 4 }
const selectStyle = { maxWidth: '100%', font: 'inherit', color: 'inherit', background: 'var(--dsw-specific-input-major)' }

function WorktreeDialog({ thread, draft, choice, idleBlock, setDraft, publishThread, close, t }) {
  const [choices, setChoices] = useState(undefined)
  const [kind, setKind] = useState(choice?.kind ?? 'local')
  const [path, setPath] = useState(choice?.path ?? '')
  const [baseRef, setBaseRef] = useState(choice?.baseRef ?? '')
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    readPage('worktrees', { cwd: thread.cwd }, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setChoices(value)
      setBaseRef(current => value?.branches.some(({ ref }) => current === ref) ? current : value?.baseRef ?? '')
      setPath(current => draft && value?.worktrees.some(tree => current === tree.path) ? current
        : (draft ? value?.worktrees[0]?.path : [value?.local, ...value?.worktrees ?? []]
          .find(tree => tree && tree.path !== thread.cwd)?.path) ?? '')
    }, failure => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => controller.abort()
  }, [draft, thread.cwd])

  async function confirm() {
    if (draft) {
      const fields = kind === 'new' ? { baseRef } : { path }
      const same = kind === choice?.kind && (kind === 'new' ? baseRef === choice.baseRef : path === choice.path)
      if (!same) setDraft(kind === 'local' ? undefined : { kind, ...fields, id: crypto.randomUUID() })
      close()
      return
    }
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

  const checkouts = !choices ? [] : draft ? choices.worktrees : [choices.local, ...choices.worktrees].filter(Boolean)
  const ready = choices && !switching && (draft ? kind === 'local' || (kind === 'new' ? baseRef : path)
    : path && path !== thread.cwd && !idleBlock)
  return <Modal open title={t(draft ? 'title' : 'switch')} onClose={() => { if (!switching) close() }} closeLabel={t('cancel')}
    footer={<>
      <Button variant="outline" disabled={switching} onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" disabled={!ready} onClick={confirm}>{t('select')}</Button>
    </>}>
    {choices === undefined && !error && <p role="status">{t('loading')}</p>}
    {choices === null && <p>{t('noRepository')}</p>}
    {choices && <div style={{ display: 'grid', gap: 12 }}>
      {draft && <label style={fieldStyle}>
        {t('title')}
        <select value={kind} onChange={event => setKind(event.target.value)} style={selectStyle}>
          <option value="local">{t('local')}</option>
          <option value="new" disabled={!choices.branches.length}>{t('new')}</option>
          <option value="existing" disabled={!checkouts.length}>{t('existing')}</option>
        </select>
      </label>}
      {draft && kind === 'new' && <label style={fieldStyle}>
        {t('base')}
        <select value={baseRef} onChange={event => setBaseRef(event.target.value)} style={selectStyle}>
          {choices.branches.map(({ ref, label }) => <option key={ref} value={ref}>{label}</option>)}
        </select>
      </label>}
      {(!draft || kind === 'existing') && <label style={fieldStyle}>
        {t('target')}
        <select value={path} onChange={event => setPath(event.target.value)} style={selectStyle} disabled={switching}>
          {!checkouts.some(tree => tree.path === path) && <option value="" disabled>{t('target')}</option>}
          {checkouts.map(tree => <option key={tree.path} value={tree.path} disabled={tree.path === thread.cwd}>
            {t(tree === choices.local ? 'local' : 'worktree')} · {tree.path}
          </option>)}
        </select>
      </label>}
      {draft && kind !== 'local' && <p>{t('begin')}</p>}
    </div>}
    {idleBlock && <p role="status">{t(idleBlock)}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

function WorktreeButton({ draft, sessionId, useSession, useProjection, useWorktreeDraft, useCodexHistory,
  useBackgroundTerminals, setDraft, publishThread, t }) {
  const [open, setOpen] = useState(false)
  const choice = useWorktreeDraft(value => value)
  const thread = useCodexHistory(snapshot => snapshot.threads.find(value => value.id === sessionId))
  const blank = useSession(state => state.blank)
  const canChange = useSession(state => state.openState === 'open' && !state.archived && !state.subagent && state.canAcceptDirectInput !== false)
  const active = useSession(state => state.live?.status?.type === 'active' || Boolean(state.pendingSubmissions?.length))
  const queued = useProjection('inbox', inbox => Boolean(inbox?.['next-turn']?.length))
  const background = useBackgroundTerminals(value => Boolean(value.get(sessionId)?.length))
  if (!thread?.cwd || !canChange || Boolean(blank) !== draft) return null
  const idleBlock = active ? 'active' : queued ? 'queue' : background ? 'background' : undefined
  const label = draft ? choice?.kind ?? 'local' : 'switch'
  return <>
    <Button size="sm" variant="toolbar" title={thread.cwd} disabled={draft && active} onClick={() => setOpen(true)}>{t(label)}</Button>
    {open && <WorktreeDialog key={thread.cwd} {...{ thread, draft, choice, setDraft, publishThread, t }}
      idleBlock={draft ? undefined : idleBlock} close={() => setOpen(false)} />}
  </>
}

/** 新会话在输入栏保存工作树选择，已有会话从标题栏切换确认后的工作目录。 */
export function installWorktrees(ctx, catalog) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  ctx.inject(['sessions'], scope => {
    for (const [name, draft] of [['conversation.input.left', true], ['conversation.session.header.utilities', false]]) {
      ctx.slots.inject(name, () => ctx.slots.register({
        name, id: 'codex-worktrees', order: 30, locale,
        inject: sessionId => {
          const { worktreeDraft } = scope.sessions.binding(sessionId).session
          return { draft, setDraft: worktreeDraft.set, hooks: { worktreeDraft, backgroundTerminals: catalog.backgroundTerminals },
            publishThread: ({ thread, workspacePaths }) => catalog.acceptThread(thread, workspacePaths),
          }
        },
      }, WorktreeButton))
    }
  })
}
