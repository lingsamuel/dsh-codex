import { useEffect, useState } from 'react'
import { formatTime, mergePages, readPage } from './api.js'
import { Transcript } from './transcript.jsx'

function groupThreads(threads, projects) {
  const groups = new Map(projects.map(project => [
    `project:${project.id}`,
    { name: project.name, location: project.roots.map(root => root.path).join(' · '), threads: [] },
  ]))

  for (const thread of threads) {
    const project = groups.get(`project:${thread.projectId}`)
    const directory = thread.cwd || '未指定工作目录'
    const key = `directory:${directory}`
    if (project) {
      project.threads.push(thread)
    } else {
      if (!groups.has(key)) {
        const name = directory.split(/[/\\]/).filter(Boolean).at(-1) || directory
        groups.set(key, { name, location: directory, threads: [] })
      }
      groups.get(key).threads.push(thread)
    }
  }

  return [...groups.entries()]
}

function threadTitle(thread) {
  return thread.name || thread.preview || thread.id
}

function Sidebar({ threads, projects, selected, onSelect, onMore, nextCursor, busy, error }) {
  return (
    <aside className="dsh-codex-sidebar" aria-label="工作区和会话">
      <header className="dsh-codex-brand"><strong>Codex</strong><span>会话</span></header>
      <div className="dsh-codex-list">
        {error && <p className="dsh-codex-error" role="alert">{error}</p>}
        {threads.length === 0 && !error && <p className="dsh-codex-muted">{busy ? '正在载入会话…' : '暂无会话'}</p>}
        {groupThreads(threads, projects).map(([key, group]) => (
          <details className="dsh-codex-workspace" key={key} open>
            <summary title={group.location}><span>{group.name}</span></summary>
            <ul>
              {group.threads.map(thread => (
                <li key={thread.id}>
                  <button type="button" aria-current={selected?.id === thread.id ? 'true' : undefined} onClick={() => onSelect(thread)}>
                    <span className="dsh-codex-thread-title">{threadTitle(thread)}</span>
                    <small>{formatTime(thread.updatedAt)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
        {nextCursor && <button className="dsh-codex-more" type="button" onClick={onMore} disabled={busy}>载入更多会话</button>}
      </div>
    </aside>
  )
}

export function History() {
  const [projects, setProjects] = useState([])
  const [threads, setThreads] = useState([])
  const [selected, select] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function loadProjects() {
      let cursor
      do {
        const page = await readPage('projects', cursor ? { cursor } : {}, controller.signal)
        setProjects(items => mergePages(items, page.data))
        cursor = page.nextCursor
      } while (cursor)
    }
    loadProjects().catch(error => {
      if (!controller.signal.aborted) setError(error.message)
    })
    readPage('threads', {}, controller.signal).then(page => {
      setThreads(page.data)
      setNextCursor(page.nextCursor)
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message)
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false)
    })
    return () => controller.abort()
  }, [])

  async function loadMore() {
    setBusy(true)
    setError('')
    try {
      const page = await readPage('threads', { cursor: nextCursor })
      setThreads(items => mergePages(items, page.data))
      setNextCursor(page.nextCursor)
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dsh-codex" lang="zh-CN">
      <Sidebar {...{ threads, projects, selected, nextCursor, busy, error }} onSelect={select} onMore={loadMore} />
      <main className="dsh-codex-conversation" aria-label="对话">
        {selected ? (
          <Transcript key={selected.id} thread={selected} title={threadTitle(selected)} onBack={() => select(null)} />
        ) : <div className="dsh-codex-empty">选择一个会话</div>}
      </main>
    </div>
  )
}
