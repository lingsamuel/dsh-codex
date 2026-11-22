export async function readPage(collection, parameters, signal) {
  const url = new URL(`api/codex/${collection}`, document.baseURI)
  url.search = new URLSearchParams(parameters).toString()
  const response = await fetch(url, { signal })
  if (response.status === 401) throw new Error('网页访问已过期，请从 DSH 的启动链接重新打开。')
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}

export function mergePages(previous, next, { prepend = false } = {}) {
  const entries = prepend ? [...next, ...previous] : [...previous, ...next]
  const unique = new Map()
  for (const entry of entries) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry)
  }
  return [...unique.values()]
}

export function formatTime(seconds) {
  return Number.isFinite(seconds)
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000)
    : null
}

export function directoryTitle(directory) {
  return directory.split(/[/\\]/).filter(Boolean).at(-1) || directory
}
