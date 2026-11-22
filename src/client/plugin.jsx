import { History } from './history.jsx'
import styles from './styles.css'

export const inject = ['slots']

export function apply(ctx) {
  // DSH 根视图总会读取可选的 Session scope。空绑定满足渲染契约，聊天直接读取 Codex。
  const absentSession = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const sessionSource = {
    getSnapshot: () => absentSession,
    subscribe: () => () => {},
  }
  ctx.slots.installScope('session', { current: sessionSource, bindingSource: () => sessionSource })

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  })
  ctx.effect(() => ctx.slots.register({ name: 'root' }, History))
}
