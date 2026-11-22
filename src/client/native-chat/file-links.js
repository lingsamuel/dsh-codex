import { parse, postprocess, preprocess } from 'micromark'

const destinationTypes = new Set(['resourceDestinationString', 'definitionDestinationString'])
const lineSuffix = /^(.+?):([1-9]\d*)(?::[1-9]\d*)?(?:[-–]([1-9]\d*)(?::[1-9]\d*)?)?$/
const lineFragment = /^L?([1-9]\d*)(?:C[1-9]\d*)?(?:-L([1-9]\d*)(?:C[1-9]\d*)?)?$/i
const windowsDrive = /^[a-z]:[/\\]/i
const scheme = /^[a-z][a-z\d+.-]*:/i
const opaqueLink = /^(?:about|blob|data|javascript|mailto|sms|tel|xmpp):/i

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
    const line = lineFragment.exec(fragment)
    return line ? `${localPath}${lineAnchor(line[1], line[2])}` : path
  }

  const line = lineSuffix.exec(path)
  if (!line) return path
  const localPath = line[1]
  if (opaqueLink.test(path) || (scheme.test(localPath) && !windowsDrive.test(localPath))) return path
  return `${localPath}${lineAnchor(line[2], line[3])}`
}

function lineAnchor(start, end) {
  return `#L${start}${end && Number(end) >= Number(start) ? `-L${end}` : ''}`
}

/** 用原生轮次的绝对目录固定文件引用，避免切换会话目录后相对路径指向另一份文件。 */
export function scopeTurnFile(path, cwd, markdown = false) {
  if (!cwd || !path || /^(?:[\/\\#?]|[a-z][a-z\d+.-]*:)/i.test(path)) return path
  const directory = cwd.replaceAll('\\', '/').replace(/\/$/, '')
  const root = markdown ? directory.split('/').map(part => windowsDrive.test(`${part}/`) ? part
    : encodeURIComponent(part).replace(/[()]/g, character => character === '(' ? '%28' : '%29')).join('/') : directory
  return `${root}/${path}`
}

/** 只改 Markdown 解析器识别出的目标位置，让 DSH 自己渲染、打开文件和定位行号。 */
export function projectFileLinks(markdown, cwd) {
  if (!cwd && !/(?:file:\/|sandbox:\/|:\d|#\d|#L\d+C)/i.test(markdown)) return markdown
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)))
  const pieces = []
  let offset = 0
  for (const [kind, token] of events) {
    if (kind !== 'enter' || !destinationTypes.has(token.type)) continue
    const start = token.start.offset
    const end = token.end.offset
    const original = markdown.slice(start, end)
    const destination = scopeTurnFile(fileDestination(original), cwd, true)
    if (original === destination) continue
    pieces.push(markdown.slice(offset, start), destination)
    offset = end
  }
  return pieces.length ? pieces.join('') + markdown.slice(offset) : markdown
}
