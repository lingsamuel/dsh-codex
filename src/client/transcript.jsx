import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button,
  CodeBlock,
  DiffBlock,
  DisclosureRow,
  IconCodeOutlineRegular,
  IconEditOutlineRegular,
  IconFolderCloseRegular,
  IconSparkleRegular,
  IconThinkOutlineRegular,
  MarkdownText,
  TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { groupCommands } from './activities.js'
import { directoryTitle, formatTime, mergePages, readPage } from './api.js'
import { toDiffHunks } from './file-change.js'

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
const diffLabels = {
  codeLabel: '差异',
  wrapLabel: '自动换行',
  unwrapLabel: '取消自动换行',
  copy: copyLabels.copyLabel,
  copied: copyLabels.copiedLabel,
  collapseAria: '折叠文件差异',
  collapse: terminalLabels.collapse,
  expandAria: terminalLabels.expandAria,
  expand: terminalLabels.expand,
}

function Message({ item, startedAt }) {
  return (
    <div className="dsh-codex-user-row">
      <div className="dsh-codex-user">
        {item.content.map((part, index) => {
          if (part.type === 'text') return <div key={index}>{part.text}</div>
          if (part.type === 'image' && /^data:image\//i.test(part.url)) {
            return <img key={index} src={part.url} alt="会话中的图片" loading="lazy" />
          }
          return <code key={index}>{part.path || part.name || (part.type === 'image' ? '图片附件' : part.type)}</code>
        })}
      </div>
      {Number.isFinite(startedAt) && <time>{formatTime(startedAt)}</time>}
    </div>
  )
}

function Activity({ title, icon = <IconCodeOutlineRegular />, summary, children }) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow className="dsh-codex-event" {...{ title, icon, open }}
      expandable expandOnRowClick onToggle={() => setOpen(value => !value)}
      collapsedContent={summary && <span className="dsh-codex-event-summary">{summary}</span>}>
      {open && <div className="dsh-codex-event-content">{children()}</div>}
    </DisclosureRow>
  )
}

function Command({ item }) {
  return (
    <Activity title="运行命令" summary={item.command}>
      {() => <TerminalBlock command={item.command} cwd={item.cwd} output={item.aggregatedOutput}
        exitCode={item.exitCode} running={item.status === 'inProgress'} labels={terminalLabels} />}
    </Activity>
  )
}

function FileChanges({ changes }) {
  return changes.map(change => {
    const diffs = toDiffHunks(change)
    if (diffs) return <DiffBlock key={change.path} diffs={diffs} labels={diffLabels} />
    return <div key={change.path}>
      <code>{change.path}</code>
      <CodeBlock code={change.diff} lang="diff" {...copyLabels} />
    </div>
  })
}

function Item({ item, startedAt }) {
  switch (item.type) {
    case 'userMessage':
      return <Message {...{ item, startedAt }} />
    case 'agentMessage':
    case 'plan':
      return (
        <div className="dsh-codex-assistant">
          <MarkdownText text={item.text} labels={markdownLabels} codeLabels={copyLabels} omitHtml />
        </div>
      )
    case 'fileChange':
      return (
        <Activity title="文件变更" icon={<IconEditOutlineRegular />}
          summary={item.changes.map(change => directoryTitle(change.path)).join('、')}>
          {() => <FileChanges changes={item.changes} />}
        </Activity>
      )
    case 'reasoning':
      return item.summary?.length ? (
        <Activity title="推理摘要" icon={<IconThinkOutlineRegular />} summary={item.summary[0]}>
          {() => <MarkdownText text={item.summary.join('\n\n')} labels={markdownLabels} codeLabels={copyLabels} omitHtml />}
        </Activity>
      ) : null
    case 'webSearch':
      return <p className="dsh-codex-muted">网页搜索 · {item.query}</p>
    default:
      return <Activity title={item.type === 'mcpToolCall' ? '已调用工具' : item.type}
        icon={<IconSparkleRegular />} summary={item.tool}>
        {() => <pre>{JSON.stringify(item, null, 2)}</pre>}
      </Activity>
  }
}

const turnStatus = { completed: '已完成', failed: '失败', interrupted: '已中断', inProgress: '进行中' }

function Turn({ turn }) {
  const firstUserId = turn.items.find(item => item.type === 'userMessage')?.id
  const content = groupCommands(turn.items)
  const answerIndex = content.findIndex(([item]) => item.type !== 'userMessage')
  const status = turnStatus[turn.status]
  const duration = Number.isFinite(turn.durationMs) ? `，用时 ${Math.round(turn.durationMs / 1000)} 秒` : ''
  const showStatus = status && (turn.status !== 'completed' || duration)

  return (
    <section className="dsh-codex-turn">
      {content.map((items, index) => {
        const item = items[0]
        let row
        if (item.type !== 'commandExecution') {
          row = <Item item={item} startedAt={item.id === firstUserId ? turn.startedAt : undefined} />
        } else if (items.length === 1) {
          row = <Command item={item} />
        } else {
          row = <Activity title={`执行了 ${items.length} 条命令`}>
            {() => items.map(command => <Command key={command.id} item={command} />)}
          </Activity>
        }
        return (
          <div key={item.id}>
            {index === answerIndex && showStatus && <div className="dsh-codex-turn-status">{status}{duration}</div>}
            {row}
          </div>
        )
      })}
      {turn.error?.message && <p className="dsh-codex-error">{turn.error.message}</p>}
    </section>
  )
}

export function Transcript({ thread, title }) {
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
        <h1 title={title}>{title}</h1>
        {thread.cwd && <span className="dsh-codex-path" title={thread.cwd}>
          <IconFolderCloseRegular />
          <span>{directoryTitle(thread.cwd)}</span>
        </span>}
      </header>
      <div className="dsh-codex-viewport" ref={viewport}>
        <div className="dsh-codex-transcript">
          {nextCursor && <Button className="dsh-codex-more" size="sm" disabled={busy} onClick={() => load(nextCursor)}>载入更早记录</Button>}
          {error && <p className="dsh-codex-error" role="alert">{error}</p>}
          {busy && turns.length === 0 && <p className="dsh-codex-muted" role="status">正在载入历史…</p>}
          {!busy && !error && turns.length === 0 && <p className="dsh-codex-muted">暂无历史消息</p>}
          {turns.map(turn => <Turn key={turn.id} turn={turn} />)}
        </div>
      </div>
    </>
  )
}
