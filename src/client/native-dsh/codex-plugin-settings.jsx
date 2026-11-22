import {
  Button, IconChevronLeftOutlineMedium, IconChevronRightOutlineRegular, IconPluginPinwheelOutlineRegular,
  IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, PathLabel, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState } from 'react'
import { pluginRequestSource, pluginUninstallId } from '../../shared/codex-plugin-source.js'
import { externalWebUrl } from '../../shared/external-url.js'
import { readPage, writeCodexCapability } from '../api.js'

const locale = 'codex.plugins'
const labels = {
  zh: {
    title: 'Codex 插件', installed: '已安装', available: '可发现的插件', disabled: '已停用', refresh: '刷新', loading: '正在读取插件…',
    empty: 'Codex 当前未返回插件。', search: '搜索插件', noResults: '没有匹配的插件。', back: '返回插件列表',
    install: '安装', uninstall: '卸载', cancel: '取消', 'confirm.install': '使用 Codex 安装 {name}？',
    'confirm.uninstall': '从 Codex 卸载 {name}？', unavailable: 'Codex 当前未开放此操作。',
    apps: 'App', connected: '已连接', authorize: '打开授权页面', authUnknown: '授权状态未知', authRequired: '需要授权',
    skills: '技能', servers: 'MCP 服务', capabilities: '能力',
    loadingCatalog: '正在读取可发现的插件…', loadingDetail: '正在读取插件详情…', loadingApps: '正在读取 App 授权状态…',
    showMore: '显示更多（剩余 {count}）',
  },
  en: {
    title: 'Codex Plugins', installed: 'Installed', available: 'Available plugins', disabled: 'Disabled', refresh: 'Refresh',
    loading: 'Reading plugins…', empty: 'Codex returned no plugins.', search: 'Search plugins', noResults: 'No matching plugins.',
    back: 'Back to plugins', install: 'Install', uninstall: 'Uninstall', cancel: 'Cancel', 'confirm.install': 'Install {name} with Codex?',
    'confirm.uninstall': 'Uninstall {name} from Codex?', unavailable: 'This action is currently unavailable in Codex.',
    apps: 'Apps', connected: 'Connected', authorize: 'Open authorization page', authUnknown: 'Unknown authorization status', authRequired: 'Authorization required',
    skills: 'Skills', servers: 'MCP servers', capabilities: 'Capabilities',
    loadingCatalog: 'Reading available plugins…', loadingDetail: 'Reading plugin details…', loadingApps: 'Reading App authorization…',
    showMore: 'Show more ({count} remaining)',
  },
}
const pluginName = plugin => plugin.interface?.displayName || plugin.name
const batchSize = 40
const cacheLifetime = 2 * 60_000

function usePluginPage(cache, page, parameters, refresh) {
  const query = parameters && new URLSearchParams(parameters).toString()
  const previousRefresh = useRef(refresh)
  const [state, setState] = useState(null)
  const cached = query == null ? undefined : cache.get(query)
  const current = state?.query === query ? state : undefined
  useEffect(() => {
    if (query == null) return
    const changed = previousRefresh.current !== refresh
    previousRefresh.current = refresh
    const hit = cache.get(query)
    if (!changed && hit?.expiresAt > Date.now()) {
      cache.delete(query)
      cache.set(query, hit)
      setState({ query })
      return
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    const params = Object.fromEntries(new URLSearchParams(query))
    if (changed && refresh?.force) params.fresh = 1
    setState({ query, loading: true })
    void readPage(page, params, signal).then(value => {
      if (controller.signal.aborted) return
      cache.delete(query)
      cache.set(query, { value, expiresAt: Date.now() + cacheLifetime })
      if (cache.size > (page === 'plugins' ? 8 : 40)) cache.delete(cache.keys().next().value)
      setState({ query })
    }).catch(error => {
      if (!controller.signal.aborted) setState({ query, error: error.message })
    })
    return () => controller.abort()
  }, [cache, page, query, refresh])
  return { value: cached?.value, loading: query != null && (current ? Boolean(current.loading) : !cached), error: current?.error }
}

function entriesOf({ catalog, installed }) {
  const entries = new Map()
  // `plugin/installed` 也能返回当前远程目录未列出的本机或账号已安装插件。
  for (const result of [catalog, installed]) {
    for (const { name, path, interface: market, plugins } of result?.marketplaces ?? []) {
      const marketplace = market?.displayName ?? name
      for (const plugin of plugins) {
        const key = JSON.stringify([path ?? name, plugin.id])
        const source = pluginRequestSource({ path, name }, plugin)
        entries.set(key, { key, plugin, marketplace, source })
      }
    }
  }
  return [...entries.values()]
}

function PluginGroup({ matches, title, choose, t }) {
  const [limit, setLimit] = useState(batchSize)
  if (!matches.length) return null
  return <section className="codex-settings-content">
    <h3>{title}</h3>
    <ul className="codex-settings-list">{matches.slice(0, limit).map(entry => {
      const { key, plugin, marketplace, source } = entry
      return <li key={key}>
        <button type="button" className="codex-settings-row" disabled={!source} onClick={() => choose(entry)}>
          <span className="codex-settings-heading">
            <span className="codex-settings-statuses">
              <strong>{pluginName(plugin)}</strong>
              {plugin.installed && !plugin.enabled && <Tag>{t('disabled')}</Tag>}
            </span>
            {plugin.interface?.shortDescription && <span className="codex-settings-secondary">{plugin.interface.shortDescription}</span>}
            <small className="codex-settings-secondary">{marketplace}</small>
          </span>
          {source && <IconChevronRightOutlineRegular size={16} aria-hidden="true" />}
        </button>
      </li>
    })}</ul>
    {matches.length > limit && <Button className="codex-settings-more" size="sm" variant="outline" data-codex-plugin-more=""
      onClick={() => setLimit(count => count + batchSize)}>{t('showMore', { count: matches.length - limit })}</Button>}
  </section>
}

function PluginList({ catalog, installed, loading, catalogLoading, search, changeSearch, choose, t }) {
  const entries = useMemo(() => entriesOf({ catalog, installed }), [catalog, installed])
  const query = search.trim().toLocaleLowerCase()
  const results = useMemo(() => query ? entries.filter(({ plugin, marketplace }) => [pluginName(plugin), plugin.name, marketplace,
    plugin.interface?.shortDescription, ...(plugin.keywords ?? [])].some(value => value?.toLocaleLowerCase().includes(query))) : entries, [entries, query])
  const groups = useMemo(() => results.reduce((groups, entry) => {
    groups[entry.plugin.installed ? 0 : 1].push(entry)
    return groups
  }, [[], []]), [results])
  const catalogErrors = [...new Set([catalog, installed].flatMap(result =>
    (result?.marketplaceLoadErrors ?? []).map(error => `${error.marketplacePath}: ${error.message}`)))]

  return <>
    {entries.length > 0 && <Input type="search" className="codex-settings-search" value={search}
      icon={<IconSearchOutlineRegular size={16} />} aria-label={t('search')} placeholder={t('search')}
      onChange={event => changeSearch(event.target.value)} />}
    {!loading && (catalog || installed) && !results.length && <p role="status" className="codex-settings-notice">{t(entries.length ? 'noResults' : 'empty')}</p>}
    <PluginGroup key={`installed:${query}`} matches={groups[0]} title={t('installed')} {...{ choose, t }} />
    {catalogLoading && <p role="status" className="codex-settings-notice">{t('loadingCatalog')}</p>}
    <PluginGroup key={`available:${query}`} matches={groups[1]} title={t('available')} {...{ choose, t }} />
    {catalogErrors.map(error => <p key={error} role="alert" className="codex-settings-notice">{error}</p>)}
  </>
}

function PluginApps({ apps, appStates, installResult, rememberLink, t }) {
  const required = new Map((installResult?.appsNeedingAuth ?? []).map(app => [app.id, app]))
  const states = new Map(appStates.map(app => [app.id, app]))
  const entries = new Map(apps.map(app => [app.id, app]))
  for (const [id, app] of required) if (!entries.has(id)) entries.set(id, app)
  if (!entries.size) return null
  return <section className="codex-settings-card codex-settings-content">
    <h3>{t('apps')}</h3>
    <ul className="codex-settings-apps">{[...entries].map(([id, app]) => {
      const state = states.get(id)
      const appUrl = externalWebUrl(required.get(id)?.installUrl ?? state?.installUrl ?? app.installUrl)
      const status = state?.isEnabled === false ? 'disabled' : state?.isAccessible ? 'connected'
        : state?.isAccessible === false || required.has(id) ? 'authRequired' : 'authUnknown'
      const tone = status === 'connected' ? 'success' : status === 'authRequired' ? 'warning' : 'neutral'
      return <li key={id} className="codex-settings-heading">
        <div className="codex-settings-statuses">
          <strong>{app.name}</strong>
          <Tag className="codex-settings-tag" tone={tone}>{t(status)}</Tag>
        </div>
        {app.description && <p className="codex-settings-secondary">{app.description}</p>}
        {appUrl && !state?.isAccessible && <a href={appUrl} target="_blank" rel="noopener noreferrer" onClick={rememberLink}>{t('authorize')}</a>}
      </li>
    })}</ul>
  </section>
}

function PluginNames({ title, values }) {
  return values?.length > 0 && <section className="codex-settings-card codex-settings-content">
    <h3>{title}</h3>
    <ul className="codex-settings-items">{values.map((value, index) => <li key={index}>{value}</li>)}</ul>
  </section>
}

function PluginDetail({ selection, detail, apps, installResult, busy, change, rememberLink, t }) {
  const [confirm, setConfirm] = useState(null)
  const plugin = detail.value?.plugin
  const summary = plugin?.summary ?? selection.plugin
  const name = pluginName(summary)
  const available = summary.availability !== 'DISABLED_BY_ADMIN' && summary.installPolicy !== 'NOT_AVAILABLE'
  const action = summary.installed ? 'uninstall' : 'install'
  const uninstallId = pluginUninstallId(summary)
  const canChange = summary.installed ? Boolean(uninstallId) : available
  const description = plugin?.description ?? summary.interface?.longDescription ?? summary.interface?.shortDescription
  const marketplacePath = plugin?.marketplacePath ?? selection.source.marketplacePath
  return <>
    <header className="codex-settings-toolbar">
      <div className="codex-settings-heading">
        <h2>{name}</h2>
        {summary.installed && <div className="codex-settings-statuses">
          <Tag className="codex-settings-tag" tone={summary.enabled ? 'success' : 'neutral'}>
            {t(summary.enabled ? 'installed' : 'disabled')}
          </Tag>
        </div>}
      </div>
      {canChange && confirm !== action && <Button variant="outline" size="sm" disabled={busy}
        onClick={() => setConfirm(action)}>{t(action)}</Button>}
    </header>
    {!canChange && <p className="codex-settings-notice">{t('unavailable')}</p>}
    {confirm === action && <div className="codex-settings-card codex-settings-toolbar">
      <p>{t(`confirm.${action}`, { name })}</p>
      <div className="codex-settings-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm(null)}>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy || !canChange}
          onClick={() => { setConfirm(null); void change(action, uninstallId) }}>{t(action)}</Button>
      </div>
    </div>}
    {(description || marketplacePath) && <div className="codex-settings-heading">
      {description && <p className="codex-settings-secondary">{description}</p>}
      {marketplacePath && <PathLabel path={marketplacePath} />}
    </div>}
    <PluginNames title={t('capabilities')} values={summary.interface?.capabilities} />
    <PluginNames title={t('skills')} values={plugin?.skills?.map(skill => skill.name)} />
    <PluginNames title={t('servers')} values={plugin?.mcpServers} />
    <PluginApps apps={plugin?.apps ?? []} appStates={apps.value?.appStates ?? []} {...{ installResult, rememberLink, t }} />
    {detail.loading && !plugin && <p role="status" className="codex-settings-notice">{t('loadingDetail')}</p>}
    {apps.loading && !apps.value && <p role="status" className="codex-settings-notice">{t('loadingApps')}</p>}
    {[...new Set([detail.error, apps.error].filter(Boolean))].map(error =>
      <p key={error} role="alert" className="codex-settings-notice">{error}</p>)}
  </>
}

function PluginSettings({ useCodexHistory, cache, t }) {
  const cwd = useCodexHistory(state => state.selected?.cwd)
  const threadId = useCodexHistory(({ selected }) => selected && !selected.archived && selected.status?.type !== 'notLoaded' ? selected.id : undefined)
  const [selection, setSelection] = useState(null)
  const [search, setSearch] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inventoryRefresh, refreshInventory] = useState(null)
  const [detailRefresh, refreshDetail] = useState(null)
  const [appsRefresh, refreshApps] = useState(null)
  const [installResult, setInstallResult] = useState(null)
  const expectingReturn = useRef(false)
  const changing = useRef(false)
  const header = useRef(null)
  const scope = cwd ? { cwd } : {}
  const installed = usePluginPage(cache.inventory, 'plugins', { ...scope, part: 'installed' }, inventoryRefresh)
  const catalog = usePluginPage(cache.inventory, 'plugins', { ...scope, part: 'catalog' }, inventoryRefresh)
  const detail = usePluginPage(cache.detail, 'plugin', selection?.source, detailRefresh)
  const appIds = detail.value?.plugin.apps?.map(app => app.id)
  const apps = usePluginPage(cache.apps, 'plugin-apps', appIds?.length
    ? { appIds: JSON.stringify(appIds), ...(threadId && { threadId }) } : null, appsRefresh)
  const loading = selection ? detail.loading || apps.loading : installed.loading || catalog.loading
  useEffect(() => {
    function returnFromAuth() {
      if (!expectingReturn.current) return
      expectingReturn.current = false
      refreshApps({ force: true })
    }
    window.addEventListener('focus', returnFromAuth)
    return () => window.removeEventListener('focus', returnFromAuth)
  }, [])

  function choose(entry) {
    setSelection(entry)
    setActionError('')
    setInstallResult(null)
    expectingReturn.current = false
    header.current?.scrollIntoView({ block: 'start', inline: 'nearest' })
  }
  function refresh() {
    setActionError('')
    if (selection) {
      refreshDetail({ force: true })
      refreshApps({ force: true })
    } else {
      refreshInventory({ force: true })
    }
  }
  async function change(action, pluginId) {
    if (changing.current) return
    changing.current = true
    setBusy(true)
    setActionError('')
    try {
      const result = await writeCodexCapability('plugins', { action, ...(action === 'install' ? selection.source : { pluginId }) })
      setInstallResult(action === 'install' ? result : null)
      for (const table of Object.values(cache)) {
        for (const entry of table.values()) entry.expiresAt = 0
      }
      refreshInventory({ force: false })
      refreshDetail({ force: false })
      refreshApps({ force: true })
    } catch (failure) {
      setActionError(failure.message)
    } finally {
      changing.current = false
      setBusy(false)
    }
  }
  return <div className="codex-settings" data-codex-plugins="">
    <header ref={header} className="codex-settings-toolbar">
      {selection
        ? <Button variant="ghost" size="sm" icon={<IconChevronLeftOutlineMedium size={14} />} disabled={busy}
            onClick={() => choose(null)}>{t('back')}</Button>
        : <h2>{t('title')}</h2>}
      <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={14} />} disabled={loading || busy}
        onClick={refresh}>{t('refresh')}</Button>
    </header>
    {actionError && <p role="alert" className="codex-settings-notice">{actionError}</p>}
    {selection
      ? <PluginDetail key={selection.key} {...{ selection, detail, apps, installResult, change, t }} busy={busy || detail.loading}
          rememberLink={() => { expectingReturn.current = true }} />
      : <>
        {installed.loading && !installed.value && <p role="status" className="codex-settings-notice">{t('loading')}</p>}
        <PluginList catalog={catalog.value?.catalog} installed={installed.value?.installed}
          catalogLoading={catalog.loading && !catalog.value} {...{ loading, search, choose, t }} changeSearch={setSearch} />
        {[...new Set([installed.error, catalog.error].filter(Boolean))].map(error =>
          <p key={error} role="alert" className="codex-settings-notice">{error}</p>)}
      </>}
  </div>
}

/** Codex 的插件设置独立显示 native catalog 并沿用 DSH 设置导航。 */
export function installCodexPluginSettings(ctx) {
  const name = 'settings.section'
  const icon = 'settings.section.icon'
  const id = 'codex-plugins'
  // 设置切页会卸载组件，缓存随插件实例保留，并按目录、插件来源和会话隔离。
  const cache = { inventory: new Map(), detail: new Map(), apps: new Map() }
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.slots.inject(name, () => ctx.slots.register({ name, id, order: 80, label: () => t('title'), locale },
    props => <PluginSettings {...props} cache={cache} />))
  ctx.slots.inject(icon, () => ctx.slots.register({ name: icon, id }, ({ size }) => <IconPluginPinwheelOutlineRegular size={size} />))
}
