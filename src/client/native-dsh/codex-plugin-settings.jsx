import {
  Button, IconChevronLeftOutlineMedium, IconChevronRightOutlineRegular, IconPluginPinwheelOutlineRegular,
  IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, PathLabel, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
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
  },
  en: {
    title: 'Codex Plugins', installed: 'Installed', available: 'Available plugins', disabled: 'Disabled', refresh: 'Refresh',
    loading: 'Reading plugins…', empty: 'Codex returned no plugins.', search: 'Search plugins', noResults: 'No matching plugins.',
    back: 'Back to plugins', install: 'Install', uninstall: 'Uninstall', cancel: 'Cancel', 'confirm.install': 'Install {name} with Codex?',
    'confirm.uninstall': 'Uninstall {name} from Codex?', unavailable: 'This action is currently unavailable in Codex.',
    apps: 'Apps', connected: 'Connected', authorize: 'Open authorization page', authUnknown: 'Unknown authorization status', authRequired: 'Authorization required',
    skills: 'Skills', servers: 'MCP servers', capabilities: 'Capabilities',
  },
}
const pluginName = plugin => plugin.interface?.displayName || plugin.name

function entriesOf({ catalog, installed }) {
  const entries = new Map()
  // `plugin/installed` 也能返回当前远程目录未列出的本机或账号已安装插件。
  for (const { marketplaces } of [catalog, installed]) {
    for (const { name, path, interface: market, plugins } of marketplaces) {
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

function PluginList({ inventory, search, changeSearch, choose, t }) {
  const entries = entriesOf(inventory)
  const query = search.trim().toLocaleLowerCase()
  const results = query ? entries.filter(({ plugin, marketplace }) => [pluginName(plugin), plugin.name, marketplace,
    plugin.interface?.shortDescription, ...(plugin.keywords ?? [])].some(value => value?.toLocaleLowerCase().includes(query))) : entries
  const catalogErrors = [...new Set([inventory.catalog, inventory.installed].flatMap(result =>
    (result.marketplaceLoadErrors ?? []).map(error => `${error.marketplacePath}: ${error.message}`)))]

  return <>
    {entries.length > 0 && <Input type="search" className="codex-settings-search" value={search}
      icon={<IconSearchOutlineRegular size={16} />} aria-label={t('search')} placeholder={t('search')}
      onChange={event => changeSearch(event.target.value)} />}
    {!results.length && <p role="status" className="codex-settings-notice">{t(entries.length ? 'noResults' : 'empty')}</p>}
    {[true, false].map(isInstalled => {
      const matches = results.filter(({ plugin }) => Boolean(plugin.installed) === isInstalled)
      if (!matches.length) return null
      return <section key={String(isInstalled)} className="codex-settings-content">
        <h3>{t(isInstalled ? 'installed' : 'available')}</h3>
        <ul className="codex-settings-list">{matches.map(({ key, plugin, marketplace, source }) => <li key={key}>
          <button type="button" className="codex-settings-row" disabled={!source} onClick={() => choose(source)}>
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
        </li>)}</ul>
      </section>
    })}
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

function PluginDetail({ result, installResult, busy, change, rememberLink, t }) {
  const [confirm, setConfirm] = useState(null)
  const { plugin, appStates, appError } = result
  const summary = plugin.summary
  const name = pluginName(summary)
  const available = summary.availability !== 'DISABLED_BY_ADMIN' && summary.installPolicy !== 'NOT_AVAILABLE'
  const action = summary.installed ? 'uninstall' : 'install'
  const uninstallId = pluginUninstallId(summary)
  const canChange = summary.installed ? Boolean(uninstallId) : available
  const description = plugin.description ?? summary.interface?.longDescription
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
    {(description || plugin.marketplacePath) && <div className="codex-settings-heading">
      {description && <p className="codex-settings-secondary">{description}</p>}
      {plugin.marketplacePath && <PathLabel path={plugin.marketplacePath} />}
    </div>}
    <PluginNames title={t('capabilities')} values={summary.interface?.capabilities} />
    <PluginNames title={t('skills')} values={plugin.skills?.map(skill => skill.name)} />
    <PluginNames title={t('servers')} values={plugin.mcpServers} />
    <PluginApps apps={plugin.apps ?? []} {...{ appStates, installResult, rememberLink, t }} />
    {appError && <p role="alert" className="codex-settings-notice">{appError}</p>}
  </>
}

function PluginSettings({ useCodexHistory, t }) {
  const cwd = useCodexHistory(state => state.selected?.cwd)
  const threadId = useCodexHistory(({ selected }) => selected && !selected.archived && selected.status?.type !== 'notLoaded' ? selected.id : undefined)
  const [inventory, setInventory] = useState(null)
  const [detail, setDetail] = useState(null)
  const [selection, setSelection] = useState(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [installResult, setInstallResult] = useState(null)
  const expectingReturn = useRef(false)
  const changing = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const fresh = refresh ? { fresh: 1 } : {}
    const reading = selection ? readPage('plugin', { ...selection, ...fresh, ...(threadId && { threadId }) }, controller.signal)
      : readPage('plugins', { ...(cwd && { cwd }), ...fresh }, controller.signal)
    void reading.then(value => {
      if (!controller.signal.aborted) (selection ? setDetail : setInventory)(value)
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [cwd, threadId, selection, refresh])
  useEffect(() => {
    function returnFromAuth() {
      if (!expectingReturn.current) return
      expectingReturn.current = false
      setRefresh(version => version + 1)
    }
    window.addEventListener('focus', returnFromAuth)
    return () => window.removeEventListener('focus', returnFromAuth)
  }, [])

  function choose(plugin) {
    setSelection(plugin)
    setDetail(null)
    setInstallResult(null)
    expectingReturn.current = false
  }
  async function change(action, pluginId) {
    if (changing.current) return
    changing.current = true
    setBusy(true)
    setError('')
    try {
      const result = await writeCodexCapability('plugins', { action, ...(action === 'install' ? selection : { pluginId }) })
      setInstallResult(action === 'install' ? result : null)
      setRefresh(version => version + 1)
    } catch (failure) {
      setError(failure.message)
    } finally {
      changing.current = false
      setBusy(false)
    }
  }
  return <div className="codex-settings" data-codex-plugins="">
    <header className="codex-settings-toolbar">
      {selection
        ? <Button variant="ghost" size="sm" icon={<IconChevronLeftOutlineMedium size={14} />} disabled={busy}
            onClick={() => choose(null)}>{t('back')}</Button>
        : <h2>{t('title')}</h2>}
      <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={14} />} disabled={loading || busy}
        onClick={() => setRefresh(version => version + 1)}>{t('refresh')}</Button>
    </header>
    {loading && <p role="status" className="codex-settings-notice">{t('loading')}</p>}
    {error && <p role="alert" className="codex-settings-notice">{error}</p>}
    {selection ? (detail && <PluginDetail result={detail} {...{ installResult, change, t }} busy={busy || loading}
      rememberLink={() => { expectingReturn.current = true }} />)
      : (inventory && <PluginList {...{ inventory, search, choose, t }} changeSearch={setSearch} />)}
  </div>
}

/** Codex 的插件设置独立显示 native catalog 并沿用 DSH 设置导航。 */
export function installCodexPluginSettings(ctx) {
  const name = 'settings.section'
  const icon = 'settings.section.icon'
  const id = 'codex-plugins'
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.slots.inject(name, () => ctx.slots.register({ name, id, order: 80, label: () => t('title'), locale }, PluginSettings))
  ctx.slots.inject(icon, () => ctx.slots.register({ name: icon, id }, ({ size }) => <IconPluginPinwheelOutlineRegular size={size} />))
}
