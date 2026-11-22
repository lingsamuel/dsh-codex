/** 由原生消息及其内容位置得到当前会话内稳定的附件 ID。 */
export function inlineAttachmentId(itemId, index) {
  return `codex:${itemId}:${index}`
}

async function decodeAttachment(attachmentId, url, signal) {
  try {
    const response = await fetch(url, { signal })
    const mediaType = response.headers.get('content-type').split(';', 1)[0]
    const data = new Uint8Array(await response.arrayBuffer())
    const image = new Image()
    image.src = url
    await image.decode()
    return [attachmentId, {
      attachment: { attachmentId, mediaType, bytes: data.byteLength, width: image.naturalWidth, height: image.naturalHeight },
      data, url,
    }]
  } catch {
    // 无法解码的附件仍由消息视图显示原有的附件文字。
    return null
  }
}

/** 将消息中的内嵌图片转换为 DSH 附件，允许队列刷新复用同一份图片数据。 */
export function readInlineUserImages(itemId, content, signal, previous) {
  const pending = []
  for (const [index, part] of content.entries()) {
    if (part.type !== 'image' || !/^data:image\//i.test(part.url)) continue
    const id = inlineAttachmentId(itemId, index)
    const cached = previous?.get(id)
    pending.push(cached?.url === part.url ? [id, cached] : decodeAttachment(id, part.url, signal))
  }
  return Promise.all(pending)
}

/** 为当前页面已有的内嵌图片准备原生 DSH 附件引用与内存中的字节。 */
export async function readInlineCodexAttachments(turns, signal) {
  const messages = turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage'))
  const images = await Promise.all(messages.map(item => readInlineUserImages(item.id, item.content, signal)))
  return new Map(images.flat().filter(Boolean))
}
