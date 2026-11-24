import { GeneralSection } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/GeneralSection.tsx'
import fontGroup from '@deepseek-ai/dsh-client-ui-theme/src/client/FontSettingsGroup.module.css'
import fontRow from '@deepseek-ai/dsh-client-ui-theme/src/client/FontSizeRow.module.css'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useState } from 'react'
import { readPage } from '../api.js'
import { CodexBrandMark } from './branding.jsx'
import { adaptSlot } from './slot-adapter.js'

export const codexSettingsItem = 'settings.codex.item'
export const codexHistorySettings = 'settings.codex.history'
export const codexTitleSettings = 'settings.codex.title'

const locale = 'codex.settings'
const labels = {
  zh: { history: '会话加速', title: '自动标题更新' },
  en: { history: 'Session loading', title: 'Automatic title updates' },
}
const folds = [[codexHistorySettings, 'history'], [codexTitleSettings, 'title']]

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

function CodexSettingsGroup({ title, children }) {
  const regionId = useId()
  const [open, setOpen] = useState(false)
  return <div className={fontGroup.group}>
    <div className={fontRow.row}>
      <div className={fontRow.rowText}>
        <div className={fontRow.title}>{title}</div>
      </div>
      <div className={fontRow.control}>
        <button type="button" className={fontRow.expander} aria-label={title} title={title}
          aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(value => !value)}>
          <IconChevronDownOutlineRegular size={12} />
        </button>
      </div>
    </div>
    {/* 收起时保留已载入的选项和进行中的自动保存。 */}
    <div id={regionId} hidden={!open}>{children}</div>
  </div>
}

function CodexSettings({ renderSlot, loadModelCatalog, t }) {
  useEffect(() => { void loadModelCatalog() }, [loadModelCatalog])
  return <GeneralSection renderSlot={(_, props) => <>
    {renderSlot(codexSettingsItem, props)}
    {folds.map(([slot, label]) => <CodexSettingsGroup key={slot} title={t(label)}>
      {renderSlot(slot, props)}
    </CodexSettingsGroup>)}
  </>} />
}

/** 用 DSH 的原生设置列呈现 Codex 偏好，条目沿用各功能自己的设置行。 */
export function installCodexSettings(ctx, loadModelCatalog) {
  const name = 'settings.section'
  const icon = 'settings.section.icon'
  const id = 'codex-on-dsh'
  ctx.effect(() => ctx.locale.register(locale, labels))
  adaptSlot(ctx, 'sidebar.settings', entry => entry.children?.['settings.launcher'], (inject, Native) => {
    function SettingsWithGeneral({ useStore, ...props }) {
      function useSettingsStore(select) {
        // 原生面板用首个导航项兜底。无指定页面时单独设定「通用」。
        return useStore(state => select(state.activeId === undefined ? { ...state, activeId: 'general' } : state))
      }
      return <Native {...props} useStore={useSettingsStore} />
    }
    return { inject, component: SettingsWithGeneral }
  })
  ctx.slots.inject(name, () => ctx.slots.register({
    name, id, order: -20, label: 'Codex on DSH', locale,
    inject: () => ({ loadModelCatalog }),
    children: {
      [codexSettingsItem]: { kind: 'list', scope: 'root' },
      [codexHistorySettings]: { kind: 'single', scope: 'root' },
      [codexTitleSettings]: { kind: 'single', scope: 'root' },
    },
  }, CodexSettings))
  ctx.slots.inject(icon, () => ctx.slots.register({ name: icon, id }, CodexBrandMark))
}
