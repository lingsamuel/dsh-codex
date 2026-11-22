const linksStyle = { display: 'flex', gap: '4px 12px', justifyContent: 'flex-end', flexWrap: 'wrap',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)' }
const locale = 'codex.file.download'
const labels = { zh: { download: '下载 {name}' }, en: { download: 'Download {name}' } }
const userContent = 'conversation.chat.user.content'

/** 原生附件卡下的下载操作沿用已保存消息或队列项的同源地址。 */
export function FileDownloads({ files, label }) {
  const linked = files.filter(file => file?.downloadUrl)
  if (!linked.length) return null
  return <div style={linksStyle}>
    {linked.map((file, index) => <a key={file.downloadUrl + ':' + index}
      href={new URL(file.downloadUrl, document.baseURI).href} download={file.name}>{label(file.name)}</a>)}
  </div>
}

/** 原生用户消息内容 Factory 同时处理首条输入和插话。 */
export function installFileDownloads(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const t = ctx.locale.bind(locale)
  ctx.effect(() => {
    const host = ctx.slots.hostFace?.()
    if (!host) return
    let current
    let restore
    function sync() {
      const entry = host.factoryOf(userContent)
      if (entry === current) return
      restore?.()
      current = entry
      restore = undefined
      if (!entry?.component || !Object.getOwnPropertyDescriptor(entry, 'component')?.writable) return
      const Native = entry.component
      function DownloadableContent(props) {
        const files = props.content.attachments.filter(part => part.type === 'file').map(part => part.file)
        return <><Native {...props} /><FileDownloads files={files} label={name => t('download', { name })} /></>
      }
      entry.component = DownloadableContent
      restore = () => { if (entry.component === DownloadableContent) entry.component = Native }
    }
    const stop = host.subscribeFactory(userContent, sync)
    sync()
    return () => { stop(); restore?.() }
  })
}
