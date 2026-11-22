export async function readPage(collection, parameters, signal) {
  const url = new URL(`api/codex/${collection}`, document.baseURI)
  url.search = new URLSearchParams(parameters).toString()
  const response = await fetch(url, { signal })
  if (response.status === 401) throw new Error('网页访问已过期，请从 DSH 的启动链接重新打开。')
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}

export function directoryTitle(directory) {
  return directory.split(/[/\\]/).filter(Boolean).at(-1) || directory
}
