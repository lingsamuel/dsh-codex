import { GeneralSection } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/GeneralSection.tsx'
import { CodexBrandMark } from './branding.jsx'

export const codexSettingsItem = 'settings.codex.item'

/** 用 DSH 的原生设置列呈现 Codex 偏好，条目沿用各功能自己的设置行。 */
export function installCodexSettings(ctx) {
  const name = 'settings.section'
  const icon = 'settings.section.icon'
  const id = 'codex-on-dsh'
  ctx.slots.inject(name, () => ctx.slots.register({
    name, id, order: -1, label: 'Codex on DSH',
    children: { [codexSettingsItem]: { kind: 'list', scope: 'root' } },
  }, ({ renderSlot }) => <GeneralSection renderSlot={(_, props) => renderSlot(codexSettingsItem, props)} />))
  ctx.slots.inject(icon, () => ctx.slots.register({ name: icon, id }, CodexBrandMark))
}
