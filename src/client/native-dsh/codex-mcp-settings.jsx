import {
  Button, IconApiOutlineMedium, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
    'runtime.disabled': '已停用', 'runtime.unknown': '暂无会话连接状态',
    'discovery.configured': '已配置', 'discovery.available': '工具可用', 'discovery.failed': '工具读取失败',
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
    'runtime.disabled': 'Disabled', 'runtime.unknown': 'Session connection status unavailable',
    'discovery.configured': 'Configured', 'discovery.available': 'Tools available', 'discovery.failed': 'Tool discovery failed',
    'auth.unknown': 'Unknown authorization status', 'auth.unsupported': 'OAuth unavailable', 'auth.notLoggedIn': 'Signed out',
    'auth.bearerToken': 'Bearer token', 'auth.oAuth': 'Signed in with OAuth',
  },
}
const runtimeTones = {
  connected: 'success',
  starting: 'info',
  authenticationRequired: 'warning',
  failed: 'danger',
}

function McpServer({ server, threadId, login, startLogin, busy, t }) {
  const tools = Object.values(server.tools ?? {})
  const { name, runtimeStatus, authStatus } = server
  const canLogin = ['notLoggedIn', 'oAuth'].includes(authStatus) || runtimeStatus === 'authenticationRequired'
  const waitingForOAuth = login?.state === 'pending'
  let status = `runtime.${runtimeStatus ?? 'unknown'}`
  let tone = runtimeTones[runtimeStatus] ?? 'neutral'
  // 全局查询没有会话连接。工具可能来自原生缓存，只用它描述工具发现结果。
  if (!threadId) {
    const available = server.serverInfo || server.toolListMeta || tools.length
    status = server.toolsError ? 'discovery.failed' : available ? 'discovery.available' : 'discovery.configured'
    tone = server.toolsError ? 'warning' : available ? 'info' : 'neutral'
  }
  return <section className="codex-settings-card codex-settings-content">
    <div className="codex-settings-toolbar">
      <div className="codex-settings-heading">
        <h3>{name}</h3>
        <div className="codex-settings-statuses">
          <Tag className="codex-settings-tag" tone={tone}>{t(status)}</Tag>
          <span className="codex-settings-secondary">{t(`auth.${authStatus ?? 'unknown'}`)}</span>
        </div>
      </div>
      {canLogin && <Button size="sm" variant="outline" disabled={busy || waitingForOAuth}
        onClick={() => void startLogin(name)}>{t('login')}</Button>}
    </div>
    {login && <div className="codex-settings-heading codex-settings-notice" role={login.state === 'failed' ? 'alert' : 'status'}>
      <p>{login.error || t(login.state)}</p>
      {['pending', 'unknown'].includes(login.state) && <a href={login.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('open')}</a>}
    </div>}
    {server.toolsError && <p role="alert" className="codex-settings-notice">{server.toolsError}</p>}
    {tools.length > 0 && <details className="codex-settings-tools">
      <summary><IconChevronRightOutlineRegular size={14} aria-hidden="true" />{t('tools', { count: tools.length })}</summary>
      <ul className="codex-settings-tool-list">{tools.map((tool, index) => <li key={index}>
        <code>{tool.name}</code>
        {tool.description && <p className="codex-settings-secondary">{tool.description}</p>}
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

  return <div className="codex-settings" data-codex-mcp="">
    <header className="codex-settings-toolbar">
      <div className="codex-settings-heading">
        <h2>{t('title')}</h2>
        <p className="codex-settings-secondary">{t(threadId ? 'session' : 'global')}</p>
      </div>
      <div className="codex-settings-actions">
        <Button size="sm" variant="outline" icon={<IconRefreshOutlineRegular size={14} />}
          onClick={() => setRefresh(version => version + 1)} disabled={loading || busy}>{t('refresh')}</Button>
        <Button size="sm" variant="outline" onClick={() => void change('reload')} disabled={busy}>{t('reload')}</Button>
      </div>
    </header>
    {loading && <p role="status" className="codex-settings-notice">{t('loading')}</p>}
    {error && <p role="alert" className="codex-settings-notice">{error}</p>}
    {servers?.length === 0 && <p role="status" className="codex-settings-notice">{t('empty')}</p>}
    {servers?.map(server => <McpServer key={server.name} {...{ server, threadId, t }} busy={busy}
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
  const icon = 'settings.section.icon'
  const id = 'codex-mcp'
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.slots.inject(name, () => ctx.slots.register({ name, id, order: 81, label: () => t('title'), locale }, McpSettings))
  ctx.slots.inject(icon, () => ctx.slots.register({ name: icon, id }, ({ size }) => <IconApiOutlineMedium size={size} />))
}
