import { Children, cloneElement, createElement, isValidElement, useCallback } from 'react'

function findSearchInput(element, placeholder) {
  if (!isValidElement(element)) return undefined
  if (element.type === 'input' && element.props.placeholder === placeholder) return element
  for (const child of Children.toArray(element.props.children)) {
    const input = findSearchInput(child, placeholder)
    if (input) return input
  }
}

/** 沿用 DSH 搜索界面，仅替换归档命中的导航，并跟随当前的归档筛选。 */
export function renderArchiveSearch(Native, props, search) {
  const filter = props.useStore(state => state.archivedFilter ?? 'default')
  const searchSessions = useCallback((query, signal) => search(query, signal, filter), [search, filter])
  if (typeof Native !== 'function') return createElement(Native, { ...props, searchSessions })
  const view = Native({ ...props, searchSessions })
  if (!isValidElement(view)) return view

  // DSH 原生 SearchResults 有独立的 open 回调，实际归档状态仍传给它以保留筛选和样式。
  const children = Children.map(view.props.children, child => {
    if (!isValidElement(child) || !Object.hasOwn(child.props, 'data-sidebar-list-area')) return child
    const results = child.props.children
    if (!isValidElement(results) || !Array.isArray(results.props.archivedSessionIds)
      || typeof results.props.onUnarchive !== 'function' || !results.props.archivedSessionIds.length) return child
    const { archivedSessionIds, open, t } = results.props
    const input = findSearchInput(view, props.t('search.placeholder'))
    return cloneElement(child, {}, cloneElement(results, {
      open(sessionId) {
        if (!archivedSessionIds.includes(sessionId)) return open(sessionId)
        // 使用原生搜索框的退出动作，再经原生主视图导航打开同一线程。
        input?.props.onKeyDown?.({ key: 'Escape' })
        props.open(sessionId)
      },
      t: (key, ...args) => key === 'toast.archivedNotOpenable' ? t('row.archived') : t(key, ...args),
    }))
  })
  return cloneElement(view, {}, children)
}
