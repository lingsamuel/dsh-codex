const fileMarker = 'dsh:file:'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function isFileMarker(element) {
  return typeof element?.placeholder === 'string' && element.placeholder.startsWith(fileMarker)
}

/** 附件是独立的原生文本段。Codex 可以读取路径，界面从原生文本元素还原附件。 */
export function fileAttachmentInput(file, path) {
  const text = `@${JSON.stringify(path)}`
  return { type: 'text', text, text_elements: [
    { byteRange: { start: 0, end: encoder.encode(text).byteLength }, placeholder: fileMarker + JSON.stringify(file) },
  ] }
}

/** 从原生历史或队列还原受管附件。 */
export function fileAttachmentOf(part) {
  if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.startsWith('@"') || part.text_elements?.length !== 1) return
  const { byteRange, placeholder } = part.text_elements[0] ?? {}
  if (!isFileMarker(part.text_elements[0])
    || byteRange?.start !== 0 || byteRange.end !== encoder.encode(part.text).byteLength) return
  try {
    const { attachmentId, name, bytes } = JSON.parse(placeholder.slice(fileMarker.length))
    if (typeof attachmentId === 'string' && /^sha256:[a-f0-9]{64}$/.test(attachmentId) && typeof name === 'string' && name
      && Number.isSafeInteger(bytes) && bytes >= 0) return { attachmentId, name, bytes }
  } catch {
    // 不完整的历史仍可把原始文本作为正文显示。
  }
}

/** 旧版历史会合并用户文本并重定位 UTF-8 范围。还原独立文件段以统一投影、下载和编辑。 */
export function splitFileAttachmentInput(part) {
  if (part.type !== 'text' || typeof part.text !== 'string' || !Array.isArray(part.text_elements)) return [part]
  const markers = part.text_elements.filter(element => isFileMarker(element)
    && Number.isSafeInteger(element.byteRange?.start) && Number.isSafeInteger(element.byteRange?.end))
    .sort((left, right) => left.byteRange.start - right.byteRange.start)
  if (!markers.length) return [part]
  const bytes = encoder.encode(part.text)
  const parts = []
  let offset = 0

  function textBetween(start, end) {
    const elements = part.text_elements.filter(element => element?.byteRange?.start >= start && element.byteRange.end <= end)
      .map(element => ({ ...element, byteRange: { start: element.byteRange.start - start, end: element.byteRange.end - start } }))
    return { type: 'text', text: decoder.decode(bytes.subarray(start, end)), text_elements: elements }
  }

  for (const { byteRange: { start, end }, placeholder } of markers) {
    if (start < offset || end <= start || end > bytes.length) continue
    const filePart = { type: 'text', text: decoder.decode(bytes.subarray(start, end)),
      text_elements: [{ byteRange: { start: 0, end: end - start }, placeholder }] }
    if (!fileAttachmentOf(filePart)) continue
    if (start > offset) parts.push(textBetween(offset, start))
    parts.push(filePart)
    offset = end
  }
  if (parts.length === 0 || parts.length === 1 && parts[0].text === part.text) return [part]
  if (offset < bytes.length) parts.push(textBetween(offset, bytes.length))
  return parts
}
