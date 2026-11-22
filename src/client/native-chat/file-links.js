import { parse, postprocess, preprocess } from 'micromark'

const destinationTypes = new Set(['resourceDestinationString', 'definitionDestinationString'])
const lineSuffix = /^(.+?):([1-9]\d*)(?::[1-9]\d*)?$/
const windowsDrive = /^[a-z]:[/\\]/i
const scheme = /^[a-z][a-z\d+.-]*:/i

function fileDestination(destination) {
  let path = destination
  if (/^file:\//i.test(path)) {
    try {
      const url = new URL(path)
      if ((url.hostname && url.hostname !== 'localhost') || url.search) return destination
      const pathname = /^\/[a-z]:\//i.test(url.pathname) ? url.pathname.slice(1) : url.pathname
      path = pathname + url.hash
    } catch {
      return destination
    }
  } else if (/^sandbox:\/mnt\/data\//i.test(path)) {
    path = path.slice('sandbox:'.length)
  }

  const hash = path.indexOf('#')
  if (hash >= 0) {
    const localPath = path.slice(0, hash)
    if (scheme.test(localPath) && !windowsDrive.test(localPath)) return destination
    const fragment = path.slice(hash + 1)
    const line = /^(?:L)?([1-9]\d*)(?:C[1-9]\d*(?:-L[1-9]\d*(?:C[1-9]\d*)?)?)?$/i.exec(fragment)
    return line ? `${localPath}#L${line[1]}` : path
  }

  const line = lineSuffix.exec(path)
  if (!line) return path
  const localPath = line[1]
  if ((scheme.test(localPath) && !windowsDrive.test(localPath)) || !/[/\\.]/.test(localPath)) return path
  return `${localPath}#L${line[2]}`
}

/** 只改 Markdown 解析器识别出的目标位置，让 DSH 自己渲染、打开文件和定位行号。 */
export function projectFileLinks(markdown) {
  if (!/(?:file:\/|sandbox:\/|:\d|#\d|#L\d+C)/i.test(markdown)) return markdown
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)))
  const pieces = []
  let offset = 0
  for (const [kind, token] of events) {
    if (kind !== 'enter' || !destinationTypes.has(token.type)) continue
    const start = token.start.offset
    const end = token.end.offset
    const original = markdown.slice(start, end)
    const destination = fileDestination(original)
    if (original === destination) continue
    pieces.push(markdown.slice(offset, start), destination)
    offset = end
  }
  return pieces.length ? pieces.join('') + markdown.slice(offset) : markdown
}
