import { Button, IconCloseCircleFillRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

const stylesheet = `
  button[data-codex-mode-label] { color: var(--dsw-alias-label-secondary); }
  [data-codex-mode-glyph] { display: inline-grid; place-items: center; width: 14px; height: 14px; }
  [data-codex-mode-glyph] > * { grid-area: 1 / 1; }
  [data-codex-mode-glyph] svg { display: block; }
  [data-codex-mode-exit] { visibility: hidden; }
  button[data-codex-mode-label]:focus-visible:not(:disabled) [data-codex-mode-icon] { visibility: hidden; }
  button[data-codex-mode-label]:focus-visible:not(:disabled) [data-codex-mode-exit] { visibility: visible; }
  @media (hover: hover) {
    button[data-codex-mode-label]:hover:not(:disabled) [data-codex-mode-icon] { visibility: hidden; }
    button[data-codex-mode-label]:hover:not(:disabled) [data-codex-mode-exit] { visibility: visible; }
  }
  @media (hover: none) {
    button[data-codex-mode-label]:not(:disabled) [data-codex-mode-icon] { visibility: hidden; }
    button[data-codex-mode-label]:not(:disabled) [data-codex-mode-exit] { visibility: visible; }
  }
`

export function installComposerModeLabel(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  })
}

/** 两种模式共用 DSH 工具行按钮。退出图标使用同一列，悬停和键盘聚焦时文字位置稳定。 */
export function ComposerModeLabel({ label, exitLabel, icon, disabled, onExit }) {
  return <Tooltip label={exitLabel} side="top" portal>
    <Button data-codex-mode-label="" size="sm" variant="ghost" aria-label={exitLabel} {...{ disabled }} onClick={onExit}
      icon={<span data-codex-mode-glyph="" aria-hidden="true">
        <span data-codex-mode-icon="">{icon}</span>
        <span data-codex-mode-exit=""><IconCloseCircleFillRegular size={14} /></span>
      </span>}>
      {label}
    </Button>
  </Tooltip>
}
