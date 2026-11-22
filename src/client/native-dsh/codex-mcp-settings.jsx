import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { readPage, writeCodexCapability } from '../api.js'

const locale = 'codex.mcpSettings'
const labels = {
  zh: {
    title: 'Codex MCP', global: '全局配置', session: '当前会话', refresh: '刷新状态', reload: '重新加载配置',
    loading: '正在读取 MCP 服务…', empty: 'Codex 当前未返回 MCP 服务。', tools: '工具（{count}）',
    login: 'OAuth 登录', open: '打开 OAuth 授权页面',
    pending: '请在授权页面完成登录。', success: 'Codex 确认 OAuth 登录成功。',
    failed: 'Codex 报告 OAuth 登录失败。', unknown: '完成授权后刷新状态。',
    'runtime.notStarted': '未启动', 'runtime.starting': '启动中', 'runtime.connected': '已连接',
    'runtime.authenticationRequired': '需要身份验证', 'runtime.failed': '连接失败', 'runtime.cancelled': '连接已取消',
    'runtime.disabled': '已停用', 'runtime.unknown': '连接状态未知',
    'auth.unknown': '授权状态未知', 'auth.unsupported': '不支持 OAuth', 'auth.notLoggedIn': '未登录',
    'auth.bearerToken': 'Bearer Token', 'auth.oAuth': '已通过 OAuth 登录',
  },
  en: {
    title: 'Codex MCP', global: 'Global configuration', session: 'Current session', refresh: 'Refresh status', reload: 'Reload configuration',
    loading: 'Reading MCP servers…', empty: 'Codex returned no MCP servers.', tools: 'Tools ({count})',
    login: 'OAuth sign-in', open: 'Open OAuth authorization page',
    pending: 'Complete sign-in on the authorization page.', success: 'Codex confirmed OAuth sign-in.',
    failed: 'Codex reported an OAuth sign-in failure.', unknown: 'Refresh status after authorization.',
    'runtime.notStarted': 'Not started', 'runtime.starting': 'Starting', 'runtime.connected': 'Connected',
    'runtime.authenticationRequired': 'Authentication required', 'runtime.failed': 'Connection failed', 'runtime.cancelled': 'Connection canceled',
    'runtime.disabled': 'Disabled', 'runtime.unknown': 'Unknown connection status',
    'auth.unknown': 'Unknown authorization status', 'auth.unsupported': 'OAuth unavailable', 'auth.notLoggedIn': 'Signed out',
    'auth.bearerToken': 'Bearer token', 'auth.oAuth': 'Signed in with OAuth',
  },
}
const column = { display: 'grid', gap: 12, alignContent: 'start', overflowWrap: 'anywhere' }
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }

function McpServer({ server, login, startLogin, busy, t }) {
  const tools = Object.values(server.tools ?? {})
  const { name, runtimeStatus, authStatus } = server
  const canLogin = ['notLoggedIn', 'oAuth'].includes(authStatus) || runtimeStatus === 'authenticationRequired'
  const waitingForOAuth = login?.state === 'pending'
  return <section style={{ display: 'grid', gap: 6 }}>
    <div style={row}>
      <div>
        <div>{name}</div>
        <small>{runtimeStatus ? t(`runtime.${runtimeStatus}`) : t('runtime.unknown')} · {t(`auth.${authStatus ?? 'unknown'}`)}</small>
      </div>
      {canLogin && <Button size="sm" variant="outline" disabled={busy || waitingForOAuth}
        onClick={() => void startLogin(name)}>{t('login')}</Button>}
    </div>
    {login && <div>
      <p role={login.state === 'failed' ? 'alert' : 'status'}>{login.error || t(login.state)}</p>
      {['pending', 'unknown'].includes(login.state) && <a href={login.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('open')}</a>}
    </div>}
    {server.toolsError && <p role="alert">{server.toolsError}</p>}
    {tools.length > 0 && <details>
      <summary>{t('tools', { count: tools.length })}</summary>
      <ul>{tools.map((tool, index) => <li key={index}>
        <code>{tool.name}</code>
        {tool.description && <div>{tool.description}</div>}
      </li>)}</ul>
    </details>}
  </section>
}

function McpInventory({ threadId, t }) {
  const [servers, setServers] = useState(null)
  const [login, setLogin] = useState(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const changing = useRef(false)
  const attemptId = login?.attemptId
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void readPage('mcp', threadId ? { threadId } : {}, controller.signal).then(({ servers }) => {
      if (!controller.signal.aborted) setServers(servers)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [threadId, refresh])
  useEffect(() => {
    if (!attemptId) return
    const controller = new AbortController()
    let timer
    async function check() {
      try {
        const result = await readPage('mcp-login', { attemptId }, controller.signal)
        if (controller.signal.aborted) return
        if (result.state === 'pending') {
          timer = setTimeout(check, 1000)
          return
        }
        setLogin(previous => previous?.attemptId === attemptId ? { ...previous, ...result } : previous)
        if (result.state === 'success') setRefresh(version => version + 1)
      } catch (failure) {
        if (!controller.signal.aborted) {
          setLogin(previous => previous?.attemptId === attemptId ? { ...previous, state: 'unknown', error: failure.message } : previous)
        }
      }
    }
    timer = setTimeout(check, 1000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [attemptId])

  async function change(action, name) {
    if (changing.current) return
    changing.current = true
    setBusy(true)
    setError('')
    try {
      if (action === 'login') {
        const result = await writeCodexCapability('mcp', { action, name, ...(threadId && { threadId }) })
        setLogin({ ...result, name, state: result.attemptId ? 'pending' : 'unknown' })
      } else {
        await writeCodexCapability('mcp', { action })
        setRefresh(version => version + 1)
      }
    } catch (failure) {
      setError(failure.message)
    } finally {
      changing.current = false
      setBusy(false)
    }
  }

  return <div style={column} data-codex-mcp="">
    <header style={row}>
      <div><strong>{t('title')}</strong><div>{t(threadId ? 'session' : 'global')}</div></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button size="sm" variant="outline" onClick={() => setRefresh(version => version + 1)} disabled={loading || busy}>{t('refresh')}</Button>
        <Button size="sm" variant="outline" onClick={() => void change('reload')} disabled={busy}>{t('reload')}</Button>
      </div>
    </header>
    {loading && <p role="status">{t('loading')}</p>}
    {error && <p role="alert">{error}</p>}
    {servers?.length === 0 && <p>{t('empty')}</p>}
    {servers?.map(server => <McpServer key={server.name} {...{ server, t }} busy={busy}
      login={login?.name === server.name ? login : undefined} startLogin={name => change('login', name)} />)}
  </div>
}

function McpSettings({ useCodexHistory, t }) {
  const threadId = useCodexHistory(({ selected }) => selected && !selected.archived && selected.status?.type !== 'notLoaded' ? selected.id : undefined)
  return <McpInventory key={threadId ?? ''} {...{ threadId, t }} />
}

/** 通过 DSH 设置显示原生 MCP 服务、工具与登录状态。 */
export function installCodexMcpSettings(ctx) {
  const name = 'settings.section'
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'codex-mcp', order: 81, label: () => t('title'), locale }, McpSettings))
}
