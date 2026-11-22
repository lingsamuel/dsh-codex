import { parse, postprocess, preprocess } from 'micromark'
import { isVisualizePath } from '../../shared/visualize-reference.js'

// 语言键只在当前投影中有效，历史里的普通 Markdown fence 不会撞上预览入口。
export const visualizeFence = `codex-visualize-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`
const referencePrefix = 'visualize'
const referenceSuffix = ''
const referenceLine = /^( {0,3})(visualize[^\r\n]*)[ \t]*(?=\r?$)/gm
const literalTokenTypes = new Set(['codeFenced', 'codeIndented', 'codeText', 'htmlFlow', 'htmlText'])

/** 从 Codex 独立成行的引用读取路径和展示选项。 */
export function parseVisualizeReference(text) {
  if (!text.startsWith(referencePrefix) || !text.endsWith(referenceSuffix)) return undefined
  try {
    const value = JSON.parse(text.slice(referencePrefix.length, -referenceSuffix.length))
    if (!isVisualizePath(value?.path)) return undefined
    return value
  } catch {
    return undefined
  }
}

/** 通过 DSH 的 Markdown fence 保留预览在正文里的顺序，并跳过代码示例和原始 HTML。 */
export function projectVisualizeReferences(markdown) {
  if (!markdown.includes(referencePrefix)) return markdown
  const lines = [...markdown.matchAll(referenceLine)]
  if (!lines.length) return markdown
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)))
  const excluded = events.filter(([kind, token]) => kind === 'enter' && literalTokenTypes.has(token.type))
  let exclusion = 0
  let offset = 0
  let output = ''
  for (const match of lines) {
    const [line, indent, reference] = match
    const start = match.index + indent.length
    while (excluded[exclusion]?.[1].end.offset <= start) exclusion++
    if (excluded[exclusion]?.[1].start.offset <= start || !parseVisualizeReference(reference)) continue
    output += markdown.slice(offset, match.index)
    if (output && !/(?:\r?\n){2}$/.test(output)) output += '\n'
    output += `\`\`\`${visualizeFence}\n${reference}\n\`\`\``
    offset = match.index + line.length
    if (offset < markdown.length && !/^(?:\r?\n){2}/.test(markdown.slice(offset))) output += '\n'
  }
  return output + markdown.slice(offset)
}
