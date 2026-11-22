import { useState } from 'react'
import {
  IconCodeOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenOutlineRegular,
  IconPanelLeftOutlineRegular,
  relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { directoryTitle, formatTime } from './api.js'
import { Transcript } from './transcript.jsx'

function groupThreads(threads, projects) {
  const groups = new Map(projects.map(project => [
    `project:${project.id}`,
    { name: project.name, location: project.roots.map(root => root.path).join(' · '), threads: [] },
  ]))

  for (const thread of threads) {
    const project = groups.get(`project:${thread.projectId}`)
    if (project) {
      project.threads.push(thread)
      continue
    }
    const directory = thread.cwd || '未指定工作目录'
    const key = `directory:${directory}`
    if (!groups.has(key)) {
      groups.set(key, { name: directoryTitle(directory), location: directory, threads: [] })
    }
    groups.get(key).threads.push(thread)
  }

  return [...groups.entries()]
}

export function threadTitle(thread) {
  return thread.name || thread.preview || thread.id
}

const timeUnits = { minutes: '分钟', hours: '小时', days: '天', months: '个月', years: '年' }

function ThreadTime({ seconds }) {
  if (!Number.isFinite(seconds)) return null
  const { unit, n } = relativeTime(seconds * 1000, Date.now())
  return <time dateTime={new Date(seconds * 1000).toISOString()} title={formatTime(seconds)}>
    {unit === 'now' ? '刚刚' : `${n}${timeUnits[unit]}`}
  </time>
}

export function SidebarToggle({ collapsed, toggle }) {
  const label = collapsed ? '展开侧栏' : '折叠侧栏'
  return (
    <button className="dsh-codex-sidebar-toggle" type="button" aria-label={label} title={label} onClick={toggle}>
      <IconPanelLeftOutlineRegular size={18} />
    </button>
  )
}

function Workspace({ group, initiallyOpen, selected, onSelect }) {
  const [limit, setLimit] = useState(5)
  return (
    <details className="dsh-codex-workspace" open={initiallyOpen}>
      <summary title={group.location}>
        <IconFolderCloseRegular className="dsh-codex-folder-closed" />
        <IconFolderOpenOutlineRegular className="dsh-codex-folder-open" />
        <span>{group.name}</span>
      </summary>
      <ul>
        {group.threads.slice(0, limit).map(thread => (
          <li key={thread.id}>
            <button type="button" aria-current={selected?.id === thread.id ? 'true' : undefined} onClick={() => onSelect(thread)}>
              <span className="dsh-codex-thread-title" title={threadTitle(thread)}>{threadTitle(thread)}</span>
              <ThreadTime seconds={thread.updatedAt} />
            </button>
          </li>
        ))}
        {group.threads.length > limit && <li>
          <button className="dsh-codex-workspace-more" type="button" onClick={() => setLimit(value => value + 10)}>
            显示更多会话
          </button>
        </li>}
      </ul>
    </details>
  )
}

export function Sidebar({ collapsed, drawer, catalog, toggle, useCodexHistory }) {
  const { projects, threads, selected, nextCursor, busy, error } = useCodexHistory(state => state)

  function select(thread) {
    catalog.select(thread)
    if (drawer && !collapsed) toggle()
  }

  return (
    <aside className="dsh-codex-sidebar" aria-label="工作区和会话" lang="zh-CN" data-collapsed={collapsed}>
      <header className="dsh-codex-brand">
        {!collapsed && <strong><IconCodeOutlineRegular size={22} />Codex</strong>}
        <SidebarToggle {...{ collapsed, toggle }} />
      </header>
      <div className="dsh-codex-sidebar-heading" hidden={collapsed}>工作区</div>
      <div className="dsh-codex-list" hidden={collapsed}>
        {error && <p className="dsh-codex-error" role="alert">{error}</p>}
        {threads.length === 0 && !error && <p className="dsh-codex-muted">{busy ? '正在载入会话…' : '暂无会话'}</p>}
        {groupThreads(threads, projects).map(([key, group], index) => (
          <Workspace key={key} group={group} initiallyOpen={index === 0} selected={selected} onSelect={select} />
        ))}
        {nextCursor && <button className="dsh-codex-more" type="button" onClick={catalog.loadMore} disabled={busy}>载入更多会话</button>}
      </div>
    </aside>
  )
}

export function History({ useCodexHistory }) {
  const selected = useCodexHistory(state => state.selected)
  return (
    <main className="dsh-codex-conversation" aria-label="对话" lang="zh-CN">
      {selected ? (
        <Transcript key={selected.id} thread={selected} title={threadTitle(selected)} />
      ) : <div className="dsh-codex-empty">选择一个会话</div>}
    </main>
  )
}
