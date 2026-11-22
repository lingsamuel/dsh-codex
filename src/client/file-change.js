import { parsePatch } from 'diff'

function hunkText(lines, side) {
  return lines.map((line, index) => {
    if (line[0] !== ' ' && line[0] !== side) return ''
    const hasTerminator = lines[index + 1]?.[0] !== '\\'
    return line.slice(1) + (hasTerminator ? '\n' : '')
  }).join('')
}

/** 将 Codex 原生变更投影为 DSH 的两个文本片段。无法识别的补丁交由原文视图显示。 */
export function toDiffHunks({ path, kind, diff }) {
  if (kind.type === 'add') return [{ path, oldText: null, newText: diff }]
  if (kind.type === 'delete') return [{ path, oldText: diff, newText: '' }]

  if (kind.move_path) {
    const trailer = `\n\nMoved to: ${kind.move_path}`
    if (diff.endsWith(trailer)) diff = diff.slice(0, -trailer.length)
    path = `${path} → ${kind.move_path}`
  }
  if (!diff.trim()) return [{ path, oldText: '', newText: '' }]

  try {
    const hunks = parsePatch(diff).flatMap(file => file.hunks)
    if (!hunks.length) return null
    return hunks.map(({ lines }) => ({
      path,
      oldText: hunkText(lines, '-'),
      newText: hunkText(lines, '+'),
    }))
  } catch {
    return null
  }
}
