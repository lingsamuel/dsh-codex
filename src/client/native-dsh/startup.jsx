import { useSyncExternalStore } from 'react'
import { adaptSlot } from './slot-adapter.js'

/** 延续 DSH 渲染器交接时的启动画面，首次会话就绪后交给原生布局。 */
export function installStartupPage(ctx, startupReady) {
  const boot = document.querySelector('#root > [data-dsh-boot]')
  if (!boot) return

  ctx.inject(['uiWorkspace', 'layout'], scope => adaptSlot(scope, 'root', entry => Boolean(entry.children?.main), (inject, Layout) => ({
    inject,
    component: function StartupLayout(props) {
      const ready = useSyncExternalStore(startupReady.subscribe, startupReady.getSnapshot)
      // DSH 交接时也从同一启动节点读取内容。保留它的字标、转圈样式和主题。
      if (!ready) return <div className={boot.className} data-dsh-boot="" role="status"
        dangerouslySetInnerHTML={{ __html: boot.innerHTML }} />
      return <Layout {...props} />
    },
  })))
}
