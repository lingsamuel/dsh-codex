const excluded = 'button, [hidden], [aria-hidden="true"], [data-text-interaction-exclude], [data-turn-process-inline]'
const blocks = 'div, p, li, dt, dd, td, th, pre, blockquote, h1, h2, h3, h4, h5, h6'

function collapseSpace(text) {
  return text.replace(/\s+/g, ' ')
}

function renderedText(message) {
  const root = message.querySelector('[data-message-bubble], [data-text-interaction-source]:not([data-turn-process-inline] *)') ?? message
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE || node.localName === 'br') return NodeFilter.FILTER_ACCEPT
      return node.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
    },
  })
  const runs = []
  let text = ''
  let previousBlock
  function separate() {
    if (text && !text.endsWith(' ')) text += ' '
  }
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      separate()
      continue
    }
    const block = node.parentElement?.closest(blocks)
    if (block !== previousBlock) separate()
    previousBlock = block
    for (const part of node.data.matchAll(/\s+|\S+/g)) {
      const [value] = part
      if (/^\s/.test(value)) separate()
      else {
        runs.push({ node, offset: part.index, start: text.length, end: text.length + value.length })
        text += value
      }
    }
  }
  return { text: text.trimEnd(), runs }
}

function matchContext({ snippet, snippetMatchRange: { start, end } }) {
  const before = snippet.slice(0, start)
  const after = snippet.slice(end)
  return {
    before: collapseSpace(before.replace(/^\.\.\. /, '')).trimStart(),
    clippedStart: before.startsWith('... '),
    match: collapseSpace(snippet.slice(start, end)),
    after: collapseSpace(after.replace(/ \.\.\.$/, '')).trimEnd(),
    clippedEnd: after.endsWith(' ...'),
  }
}

function matchesContext(text, start, { before, match, after, clippedStart, clippedEnd }) {
  return (clippedStart || start === before.length)
    && (clippedEnd || start + match.length + after.length === text.length)
    && text.startsWith(match + after, start)
    && text.slice(Math.max(0, start - before.length), start) === before
}

function pickMatch(text, hit, page, context) {
  const sameMessage = result => result.turnId === hit.turnId && result.itemId === hit.itemId
  const complete = !page.nextCursor || !sameMessage(page.data.at(-1))
  if (complete) {
    // Codex 按正文顺序返回各处命中。确认这条消息的所有命中都与正文对应后，用顺序区分相同的摘要。
    const hits = page.data.filter(sameMessage)
    const literal = collapseSpace(page.searchTerm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches = [...text.matchAll(new RegExp(literal, 'giu'))]
    if (matches.length === hits.length && hits.every((result, index) => matchesContext(text, matches[index].index, matchContext(result)))) {
      return matches[hits.indexOf(hit)]?.index
    }
  }

  let match
  for (let start = text.indexOf(context.match); start !== -1; start = text.indexOf(context.match, start + 1)) {
    if (!matchesContext(text, start, context)) continue
    if (match !== undefined) return undefined
    match = start
  }
  return match
}

/** 仅在摘要和已渲染正文能对应时生成文本 Range，调用方可保留消息级高亮作为回退。 */
export function renderedSearchMatch(message, hit, page) {
  const context = matchContext(hit)
  if (!context.match) return undefined
  const { text, runs } = renderedText(message)
  const start = pickMatch(text, hit, page, context)
  if (start === undefined) return undefined
  const end = start + context.match.length
  const first = runs.find(run => run.start <= start && run.end > start)
  const last = runs.find(run => run.start < end && run.end >= end)
  if (!first || !last) return undefined
  const range = message.ownerDocument.createRange()
  range.setStart(first.node, first.offset + start - first.start)
  range.setEnd(last.node, last.offset + end - last.start)
  return range
}
