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
      data,
    }]
  } catch {
    // 无法解码的附件仍由消息视图显示原有的附件文字。
    return null
  }
}

/** 为当前页面已有的内嵌图片准备原生 DSH 附件引用与内存中的字节。 */
export async function readInlineCodexAttachments(turns, signal) {
  const pending = []
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue
      for (const [index, part] of item.content.entries()) {
        if (part.type === 'image' && /^data:image\//i.test(part.url)) {
          pending.push(decodeAttachment(inlineAttachmentId(item.id, index), part.url, signal))
        }
      }
    }
  }
  return new Map((await Promise.all(pending)).filter(Boolean))
}
