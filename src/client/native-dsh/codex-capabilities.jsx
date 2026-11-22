import { installCodexPluginSettings } from './codex-plugin-settings.jsx'
import { installCodexMcpSettings } from './codex-mcp-settings.jsx'

const settingsStyles = `
  .codex-settings {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 16px;
    color: var(--dsw-alias-label-primary);
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .codex-settings :where(h2, h3, p, ul) { margin: 0; }
  .codex-settings h2 { font-size: 20px; line-height: 1.3; font-weight: 600; }
  .codex-settings h3 { font-size: 14px; font-weight: 600; }
  .codex-settings-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .codex-settings-toolbar > :first-child { min-width: 0; }
  .codex-settings-actions, .codex-settings-statuses {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
  }
  .codex-settings .codex-settings-tag[data-tone] { color: var(--dsw-alias-label-primary); }
  .codex-settings-secondary {
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
  }
  .codex-settings-content, .codex-settings-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .codex-settings-heading { gap: 4px; }
  .codex-settings-search { min-width: 0; }
  .codex-settings-more { justify-self: start; }
  .codex-settings-list {
    padding: 0;
    list-style: none;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-md);
  }
  .codex-settings-list > li + li { border-block-start: 1px solid var(--dsw-alias-border-l2); }
  .codex-settings-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    box-sizing: border-box;
    width: 100%;
    padding: 12px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    overflow-wrap: inherit;
    cursor: pointer;
  }
  .codex-settings-list > li:first-child > .codex-settings-row {
    border-start-start-radius: var(--dsw-radius-md);
    border-start-end-radius: var(--dsw-radius-md);
  }
  .codex-settings-list > li:last-child > .codex-settings-row {
    border-end-start-radius: var(--dsw-radius-md);
    border-end-end-radius: var(--dsw-radius-md);
  }
  .codex-settings-row:disabled { cursor: default; }
  .codex-settings-row:focus-visible { outline-offset: -2px; }
  @media (hover: hover) {
    .codex-settings-row:enabled:hover {
      background: var(--dsw-alias-interactive-bg-hover);
    }
  }
  .codex-settings-card {
    padding: 12px;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-md);
  }
  .codex-settings-card > .codex-settings-toolbar > .codex-settings-heading { flex: 1 1 12rem; }
  .codex-settings-items { padding-inline-start: 20px; }
  .codex-settings-apps, .codex-settings-tool-list { padding: 0; list-style: none; }
  .codex-settings-apps > li + li, .codex-settings-tool-list > li + li {
    margin-block-start: 8px;
    padding-block-start: 8px;
    border-block-start: 1px solid var(--dsw-alias-border-l2);
  }
  .codex-settings-tool-list { padding: 4px 0 0 18px; }
  .codex-settings-tool-list code { white-space: normal; }
  .codex-settings-notice {
    padding: 10px 12px;
    border-radius: var(--dsw-radius-sm);
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
  }
  .codex-settings-notice[role="alert"] {
    border-inline-start: 2px solid var(--dsw-alias-state-error-primary);
    background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
    color: var(--dsw-alias-label-primary);
  }
  .codex-settings a {
    justify-self: start;
    color: var(--dsw-alias-state-business-primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
`

/** 挂载由 Codex 提供数据与操作的设置页面。 */
export function installCodexCapabilities(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = settingsStyles
    document.head.append(style)
    return () => style.remove()
  })
  installCodexPluginSettings(ctx)
  installCodexMcpSettings(ctx)
}
