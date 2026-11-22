import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CodeBlock, MarkdownText, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatTime, mergePages, readPage } from './api.js'

const copyLabels = { copyLabel: '复制', copiedLabel: '已复制' }
const markdownLabels = { code: copyLabels, footnotes: '脚注' }
const terminalLabels = {
  commandLine: line => `命令第 ${line} 行`,
  signal: signal => `信号 ${signal}`,
  exitCode: code => `退出码 ${code}`,
  noExitCode: '无退出码',
  running: '执行中',
  failed: '失败',
  done: '完成',
  copy: '复制',
  copied: '已复制',
  noOutput: '无输出',
  collapseAria: '折叠命令输出',
  collapse: '折叠',
  expandAria: lines => `展开剩余 ${lines} 行`,
  expand: lines => `展开 ${lines} 行`,
}

function Message({ item }) {
  return (
    <div className="dsh-codex-user">
      {item.content.map((part, index) => {
        if (part.type === 'text') return <div key={index}>{part.text}</div>
        if (part.type === 'image' && /^data:image\//i.test(part.url)) {
          return <img key={index} src={part.url} alt="会话中的图片" loading="lazy" />
        }
        return <code key={index}>{part.path || part.name || (part.type === 'image' ? '图片附件' : part.type)}</code>
      })}
    </div>
  )
}

function RawItem({ item }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="dsh-codex-event" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{item.type}</summary>
      {open && <pre>{JSON.stringify(item, null, 2)}</pre>}
    </details>
  )
}

function Item({ item }) {
  switch (item.type) {
    case 'userMessage':
      return <Message item={item} />
    case 'agentMessage':
    case 'plan':
      return (
        <div className="dsh-codex-assistant">
          <MarkdownText text={item.text} labels={markdownLabels} codeLabels={copyLabels} omitHtml />
        </div>
      )
    case 'commandExecution':
      return (
        <details className="dsh-codex-event">
          <summary><code>{item.command}</code></summary>
          <TerminalBlock command={item.command} cwd={item.cwd} output={item.aggregatedOutput}
            exitCode={item.exitCode} running={item.status === 'inProgress'} labels={terminalLabels} />
        </details>
      )
    case 'fileChange':
      return (
        <details className="dsh-codex-event">
          <summary>文件变更 · {item.changes.length}</summary>
          {item.changes.map((change, index) => (
            <div className="dsh-codex-change" key={index}>
              <code>{change.path}</code>
              {change.diff && <CodeBlock code={change.diff} lang="diff" {...copyLabels} />}
            </div>
          ))}
        </details>
      )
    case 'reasoning':
      return item.summary?.length ? (
        <details className="dsh-codex-event">
          <summary>推理摘要</summary>
          <MarkdownText text={item.summary.join('\n\n')} labels={markdownLabels} codeLabels={copyLabels} omitHtml />
        </details>
      ) : null
    case 'webSearch':
      return <p className="dsh-codex-muted">网页搜索 · {item.query}</p>
    default:
      return <RawItem item={item} />
  }
}

const turnStatus = { failed: '失败', interrupted: '已中断', inProgress: '进行中' }

export function Transcript({ thread, title, onBack }) {
  const [turns, setTurns] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const viewport = useRef(null)
  const scrollAnchor = useRef(0)
  const request = useRef(null)

  async function load(cursor) {
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      const page = await readPage('turns', {
        threadId: thread.id,
        ...(cursor ? { cursor } : {}),
      }, controller.signal)
      scrollAnchor.current = cursor ? viewport.current.scrollHeight - viewport.current.scrollTop : 0
      setTurns(items => mergePages(items, page.data.toReversed(), { prepend: true }))
      setNextCursor(page.nextCursor)
    } catch (error) {
      if (!controller.signal.aborted) setError(error.message)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [thread.id])

  useLayoutEffect(() => {
    const area = viewport.current
    area.scrollTop = area.scrollHeight - scrollAnchor.current
  }, [turns])

  return (
    <>
      <header className="dsh-codex-header">
        <button className="dsh-codex-back" type="button" onClick={onBack} aria-label="返回会话列表">‹</button>
        <div>
          <h1 title={title}>{title}</h1>
          {thread.cwd && <p className="dsh-codex-path" title={thread.cwd}>{thread.cwd}</p>}
        </div>
      </header>
      <div className="dsh-codex-viewport" ref={viewport}>
        <div className="dsh-codex-transcript">
          {nextCursor && <button className="dsh-codex-more" type="button" disabled={busy} onClick={() => load(nextCursor)}>载入更早记录</button>}
          {error && <p className="dsh-codex-error" role="alert">{error}</p>}
          {busy && turns.length === 0 && <p className="dsh-codex-muted" role="status">正在载入历史…</p>}
          {!busy && !error && turns.length === 0 && <p className="dsh-codex-muted">暂无历史消息</p>}
          {turns.map(turn => (
            <section className="dsh-codex-turn" key={turn.id}>
              <div className="dsh-codex-meta">
                {turn.startedAt != null && <time>{formatTime(turn.startedAt)}</time>}
                {turnStatus[turn.status] && <span>{turnStatus[turn.status]}</span>}
              </div>
              {turn.items.map(item => <Item key={item.id} item={item} />)}
              {turn.error?.message && <p className="dsh-codex-error">{turn.error.message}</p>}
            </section>
          ))}
        </div>
      </div>
    </>
  )
}
