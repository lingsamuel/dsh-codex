import { useSyncExternalStore } from 'react'
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { modeHandoffStyles } from '../../shared/web-mode-handoff.js'
import { CodexBrandMark, CodexBrandName } from './branding.jsx'

const artwork = {
  dsh: { wordWidth: 103.348, badgeWidth: 52, Wordmark: () => <BrandWordmark includeMark={false} />, Mark: FishLogo },
  codex: { wordWidth: 68.25, badgeWidth: 41, Wordmark: CodexBrandName, Mark: CodexBrandMark },
}

const duration = 560

const styles = `
[data-codex-mode-brand] { display: inline-flex; align-items: center; height: 24px; }
[data-codex-mode-brand], [data-codex-mode-mark] { vertical-align: middle; }
[data-codex-mode-mark] { display: inline-grid; place-items: center; }
[data-codex-mode-mark] svg { display: block; }
[data-codex-mode-mark] > :is([data-codex-mode-outgoing], [data-codex-mode-incoming]) {
  grid-area: 1 / 1;
  inline-size: 100%;
  block-size: 100%;
  display: grid;
  place-items: center;
}
[data-codex-mode-stack] { display: inline-grid; position: relative; flex: none; }
[data-codex-mode-stack] > * { grid-area: 1 / 1; }
[data-codex-mode-crop] { display: block; overflow: hidden; position: relative; flex: none; }
[data-codex-mode-crop] svg { display: block; max-width: none; }
[data-codex-mode-badge] { display: inline-block; flex: none; padding-block: 5px; }
[data-codex-mode-badge][data-clickable] { cursor: pointer; }
[data-codex-mode-card] { display: grid; transform-style: preserve-3d; transform-origin: center; }
[data-codex-mode-card] > * { grid-area: 1 / 1; backface-visibility: hidden; }
[data-codex-mode-front] { transform: rotateY(0deg); }
[data-codex-mode-back] { transform: rotateY(180deg); }
[data-codex-mode-card][data-flipping] { animation: codex-mode-flip ${duration}ms ease-in-out both; }
[data-codex-mode-front="old"] { animation: codex-mode-hide-face ${duration}ms step-end both; }
[data-codex-mode-front="new"] { animation: codex-mode-show-face ${duration}ms step-end both; }
[data-codex-mode-outgoing] { animation: codex-mode-out ${duration}ms ease both; }
[data-codex-mode-incoming] { animation: codex-mode-in ${duration}ms ease both; }
[data-codex-mode-resizing] {
  animation: codex-mode-width ${duration}ms ease-in-out both;
}
@keyframes codex-mode-flip {
  from { transform: perspective(180px) rotateY(0deg); }
  to { transform: perspective(180px) rotateY(var(--codex-mode-turn)); }
}
@keyframes codex-mode-hide-face { 0% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes codex-mode-show-face { 0% { opacity: 0; } 50%, 100% { opacity: 1; } }
@keyframes codex-mode-out {
  0% { opacity: 1; transform: translateX(0); }
  45%, 100% { opacity: 0; transform: translateX(-6px); }
}
@keyframes codex-mode-in {
  0%, 38% { opacity: 0; transform: translateX(6px); }
  100% { opacity: 1; transform: translateX(0); }
}
@keyframes codex-mode-width {
  from { width: var(--codex-mode-width-from); }
  to { width: var(--codex-mode-width-to); }
}
`

function resize(from, to, active) {
  return {
    width: from,
    ...(active && { '--codex-mode-width-from': from + 'px', '--codex-mode-width-to': to + 'px' }),
  }
}

function ArtworkCrop({ mode, badge }) {
  const { wordWidth, badgeWidth, Wordmark } = artwork[mode]
  return <span data-codex-mode-crop style={{ width: badge ? badgeWidth : wordWidth, height: badge ? 14 : 24 }}>
    <span style={badge ? { position: 'absolute', left: -wordWidth, top: -5.5 } : undefined}>
      <Wordmark />
    </span>
  </span>
}

function ModeMark({ size, state }) {
  const { mode, motion } = useSyncExternalStore(state.subscribe, state.getSnapshot)
  const Mark = (artwork[mode] ?? artwork.dsh).Mark
  const Target = motion && artwork[motion.to].Mark
  // 鲸鱼图稿比方形图标矮，静止、动画和交接都使用同一个方形图标格。
  return <span data-codex-mode-mark aria-hidden={motion ? 'true' : undefined} style={{ width: size, height: size }}>
    {Target ? <>
      <span data-codex-mode-outgoing><Mark size={size} /></span>
      <span data-codex-mode-incoming><Target size={size} /></span>
    </> : <Mark size={size} />}
  </span>
}

function ModeBrand({ state, change, t }) {
  const { mode, available, exclusive, pending, stale, motion } = useSyncExternalStore(state.subscribe, state.getSnapshot)
  const current = artwork[mode] ? mode : 'dsh'
  const next = motion?.to ?? current
  const from = artwork[current]
  const to = artwork[next]
  const clickable = available && !exclusive && !stale
  return <span data-codex-mode-brand>
    <span data-codex-mode-stack data-codex-mode-resizing={motion ? '' : undefined}
      style={resize(from.wordWidth, to.wordWidth, motion)}>
      <span data-codex-mode-outgoing={motion ? '' : undefined}><ArtworkCrop mode={current} /></span>
      {motion && <span data-codex-mode-incoming><ArtworkCrop mode={next} /></span>}
    </span>
    <span data-codex-mode-badge=""
      data-clickable={clickable && !pending ? '' : undefined}
      title={clickable && !pending ? t(mode === 'codex' ? 'switchDsh' : 'mode') : undefined}
      onClick={event => {
        // 官方品牌区本身有新建会话动作。徽标只消费自己的点击。
        event.stopPropagation()
        if (clickable && !pending) return change('defaultMode', current === 'codex' ? 'dsh' : 'codex')
      }}>
      <span data-codex-mode-card data-flipping={motion ? '' : undefined}
        data-codex-mode-resizing={motion ? '' : undefined}
        style={{ ...resize(from.badgeWidth, to.badgeWidth, motion), '--codex-mode-turn': next === 'codex' ? '360deg' : '-360deg' }}
        onAnimationEnd={event => {
          if (event.target === event.currentTarget && event.animationName === 'codex-mode-flip') motion?.finish()
        }}>
        <span data-codex-mode-front={motion ? 'old' : ''}><ArtworkCrop mode={current} badge /></span>
        {motion && <>
          <span data-codex-mode-back><ArtworkCrop mode={next} badge /></span>
          <span data-codex-mode-front="new"><ArtworkCrop mode={next} badge /></span>
        </>}
      </span>
    </span>
  </span>
}

/** 品牌显示随页面模式切换。在窄栏里继续使用原生侧栏展开控件。 */
export function installModeBrand(ctx, state, change, t) {
  ctx.effect(() => {
    if (!document.head) return
    const style = document.createElement('style')
    style.textContent = modeHandoffStyles + styles
    document.head.append(style)
    return () => style.remove()
  })
  for (const [name, component] of [['sidebar.brand.mark', ModeMark], ['sidebar.brand.name', ModeBrand]]) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -1,
      inject: () => ({ state, change, t }),
    }, component))
  }
}

/** 等可见徽标转完。后台标签页可能暂停 CSS 动画，届时仍要完成导航。 */
export async function playModeBrand(state, current, to) {
  const badge = document.querySelector('[data-codex-mode-badge]')
  if (current.mode === to || !badge?.getClientRects().length || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const { promise, resolve } = Promise.withResolvers()
  const timer = window.setTimeout(resolve, duration + 180)
  try {
    state.set({ ...state.getSnapshot(), motion: { to, finish: resolve } })
    await promise
  } finally {
    window.clearTimeout(timer)
  }
}
