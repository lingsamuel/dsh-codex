const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** DSH 原生草稿会把这几类文件编码为内嵌图片。 */
export function isComposerImageType(mediaType) {
  return mediaTypes.has(mediaType)
}

/** 只允许随本次消息上传的图片数据进入 Codex 的图片输入。 */
export function isComposerImageUrl(url) {
  if (typeof url !== 'string') return false
  const header = /^data:([^;,]+);base64,/.exec(url)
  if (!header || !isComposerImageType(header[1])) return false
  const data = url.slice(header[0].length)
  return data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)
}
