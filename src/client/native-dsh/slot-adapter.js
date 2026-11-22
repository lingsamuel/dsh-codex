/** 适配现有 DSH 插槽。原生条目替换或卸载后撤回本次修改。 */
export function adaptSlot(ctx, slot, find, adapt) {
  return ctx.effect(() => {
    let entry
    let restore
    function sync() {
      const next = ctx.slots.entries(slot).find(find)
      if (entry === next) return
      restore?.()
      entry = next
      restore = undefined
      if (!entry?.component || !entry.inject) return
      const { inject, component } = entry
      const replacement = adapt(inject, component)
      entry.inject = replacement.inject
      entry.component = replacement.component
      restore = () => {
        if (next.inject === replacement.inject) next.inject = inject
        if (next.component === replacement.component) next.component = component
      }
    }
    const stop = ctx.on('slots/changed', name => { if (slot === name) sync() })
    sync()
    return () => { stop(); restore?.() }
  })
}
