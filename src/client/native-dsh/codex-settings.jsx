import { GeneralSection } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/GeneralSection.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { useEffect } from 'react'
import { readPage } from '../api.js'
import { CodexBrandMark } from './branding.jsx'

export const codexSettingsItem = 'settings.codex.item'

/** 在插件生命周期保留已读的 Profile 偏好，防止旧读取覆盖已应用的设置。 */
export function createCodexPreference(endpoint, signal) {
  const store = createSnapshotStore({ value: null, error: '', saving: false })
  let revision = 0

  function publish(value) {
    store.update(state => { state.value = value; state.error = '' })
  }

  async function load() {
    const read = ++revision
    try {
      const value = await readPage(endpoint, {}, signal)
      if (!signal.aborted && read === revision) publish(value)
    } catch (error) {
      if (!signal.aborted && read === revision) store.update(state => { state.error = error.message })
    }
  }

  return {
    store, load,
    async save(write) {
      if (store.getSnapshot().saving) return false
      const before = revision
      store.update(state => { state.saving = true })
      try {
        const value = await write()
        if (signal.aborted) return false
        // 写入时若收到其他标签页的更新，重新核对 Host 当前值。
        if (before !== revision) void load()
        else {
          ++revision
          publish(value)
        }
        return true
      } finally {
        if (!signal.aborted) store.update(state => { state.saving = false })
      }
    },
  }
}

function CodexSettings({ renderSlot, loadModelCatalog }) {
  useEffect(() => { void loadModelCatalog() }, [loadModelCatalog])
  return <GeneralSection renderSlot={(_, props) => renderSlot(codexSettingsItem, props)} />
}

/** 用 DSH 的原生设置列呈现 Codex 偏好，条目沿用各功能自己的设置行。 */
export function installCodexSettings(ctx, loadModelCatalog) {
  const name = 'settings.section'
  const icon = 'settings.section.icon'
  const id = 'codex-on-dsh'
  ctx.slots.inject(name, () => ctx.slots.register({
    name, id, order: -1, label: 'Codex on DSH',
    inject: () => ({ loadModelCatalog }),
    children: { [codexSettingsItem]: { kind: 'list', scope: 'root' } },
  }, CodexSettings))
  ctx.slots.inject(icon, () => ctx.slots.register({ name: icon, id }, CodexBrandMark))
}
