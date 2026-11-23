export const modeHandoffKey = 'dsh-codex:web-mode-handoff'

export const modeHandoffStyles = `
  [data-codex-mode-arrival] {
    position: fixed;
    inset: 0;
    z-index: 1000;
    pointer-events: none;
    background: var(--dsw-alias-bg-base, Canvas);
  }
  [data-codex-mode-sidebar] :not(
    [data-codex-mode-mark], [data-codex-mode-brand],
    [data-codex-mode-mark] *, [data-codex-mode-brand] *,
    :has([data-codex-mode-mark], [data-codex-mode-brand])
  ) {
    opacity: 0 !important;
  }
  [data-codex-mode-loading] {
    position: fixed;
    inset: 0 0 0 var(--codex-mode-workspace-left, 0px);
    z-index: 1001;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: var(--dsw-alias-bg-base, Canvas);
    color: var(--dsw-alias-label-secondary, CanvasText);
    font: 14px/1.5 system-ui, sans-serif;
    pointer-events: none;
  }
  [data-codex-mode-arrival] [data-codex-mode-loading] {
    background: inherit;
  }
  [data-codex-mode-loading-title] {
    block-size: 24px;
    font: 600 16px/24px system-ui, sans-serif;
    letter-spacing: 0.14em;
    color: var(--codex-mode-loading-title-color, var(--dsw-alias-label-primary, CanvasText));
  }
  [data-codex-mode-loading-label] {
    block-size: 20px;
    line-height: 20px;
    max-inline-size: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  [data-codex-mode-spinner] {
    box-sizing: border-box;
    inline-size: 24px;
    block-size: 24px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
    border-inline-end-color: currentColor;
    animation: codex-mode-wait 850ms linear infinite;
  }
  @keyframes codex-mode-wait { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    [data-codex-mode-spinner] { animation: none; }
  }
  html[data-codex-mode-arriving] #root :is([data-dsh-boot]:has([data-dsh-boot-spinner]), [data-codex-session-loading]) {
    opacity: 0;
    pointer-events: none;
  }
`

function getModeLayout() {
  const rightbar = document.querySelector('[data-rightbar-col]')
  const workspace = rightbar?.previousElementSibling
  const sidebar = workspace?.previousElementSibling
  return { frame: rightbar?.parentElement, workspace, sidebar }
}

export function getModeBrandPieces(root, incoming = false) {
  const mark = root.querySelector('[data-codex-mode-mark]')
  const brand = root.querySelector('[data-codex-mode-brand]')
  return [
    ['mark', (incoming && mark?.querySelector('[data-codex-mode-incoming]')) || mark],
    ['word', (incoming && brand?.querySelector('[data-codex-mode-incoming] [data-codex-mode-crop]'))
      || brand?.querySelector('[data-codex-mode-stack] [data-codex-mode-crop]')],
    ['badge', (incoming && brand?.querySelector('[data-codex-mode-front="new"] [data-codex-mode-crop]'))
      || brand?.querySelector('[data-codex-mode-front] [data-codex-mode-crop]')],
  ]
}

function workspaceLeft(workspace, sidebar) {
  return Math.max(0, workspace?.getBoundingClientRect().left ?? 0, sidebar?.getBoundingClientRect().right ?? 0)
}

/** 同一个布局贯穿离开和抵达，跨页时让转圈接着上一页的时间线。 */
export function createModeLoading(label, startedAt) {
  const now = Date.now()
  const start = Number.isFinite(startedAt) ? startedAt : now
  const loading = document.createElement('div')
  loading.setAttribute('data-codex-mode-loading', '')
  loading.dataset.codexModeLoadingStarted = String(start)
  loading.setAttribute('role', 'status')
  const title = document.createElement('span')
  title.setAttribute('data-codex-mode-loading-title', '')
  title.setAttribute('aria-hidden', 'true')
  title.textContent = 'HARNESS'
  const spinner = document.createElement('span')
  spinner.setAttribute('data-codex-mode-spinner', '')
  spinner.setAttribute('aria-hidden', 'true')
  spinner.style.animationDelay = -Math.max(0, now - start) + 'ms'
  const text = document.createElement('span')
  text.setAttribute('data-codex-mode-loading-label', '')
  text.textContent = label
  loading.append(title, spinner, text)
  return loading
}

/** 请求切换时只留品牌，暂停界面下方的其他侧栏内容。 */
export function beginModeLoading(label) {
  const { workspace, sidebar } = getModeLayout()
  if (!workspace) return () => {}
  const loading = createModeLoading(label)
  loading.style.left = workspaceLeft(workspace, sidebar) + 'px'
  sidebar?.setAttribute('data-codex-mode-sidebar', '')
  document.body.append(loading)
  return () => {
    loading.remove()
    sidebar?.removeAttribute('data-codex-mode-sidebar')
  }
}

function capturePiece(kind, node) {
  const svg = node?.querySelector('svg')
  if (!svg) return
  const { x, y, width, height } = node.getBoundingClientRect()
  if (!width || !height || x + width <= 0 || y + height <= 0) return
  const box = svg.getBoundingClientRect()
  const style = getComputedStyle(svg)
  const picture = svg.cloneNode(true)
  picture.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  picture.style.color = style.color
  picture.style.setProperty('--dsw-alias-label-primary-inverted', style.getPropertyValue('--dsw-alias-label-primary-inverted'))
  return {
    kind,
    x, y, width, height,
    image: { x: box.x - x, y: box.y - y, width: box.width, height: box.height },
    // 浏览器把它作为图片载入。不会把跨文档数据作为 HTML 插入。
    src: 'data:image/svg+xml,' + encodeURIComponent(picture.outerHTML),
  }
}

/** 在切换动画最后一帧保留品牌图稿与原生侧栏的颜色和位置。 */
export function saveModeHandoff(url, labels) {
  try {
    const target = new URL(url)
    const { frame, sidebar: side, workspace } = getModeLayout()
    const sidebar = side?.getBoundingClientRect()
    const pieces = getModeBrandPieces(document, true).map(([kind, node]) => capturePiece(kind, node)).filter(Boolean)
    const loading = document.querySelector('[data-codex-mode-loading]')
    const title = loading?.querySelector('[data-codex-mode-loading-title]')
    const loadingStyle = loading && getComputedStyle(loading)
    sessionStorage.setItem(modeHandoffKey, JSON.stringify({
      path: target.pathname,
      mode: target.searchParams.get('mode'),
      expires: Date.now() + 15_000,
      workspaceLeft: workspaceLeft(workspace, side),
      labels,
      startedAt: loading && Number(loading.dataset.codexModeLoadingStarted),
      loadingColor: loadingStyle?.color,
      loadingBackground: loadingStyle?.backgroundColor,
      loadingTitleColor: title && getComputedStyle(title).color,
      background: frame && getComputedStyle(frame).backgroundColor,
      sidebar: sidebar && {
        x: sidebar.x, y: sidebar.y, width: sidebar.width, height: sidebar.height,
        background: getComputedStyle(side).backgroundColor,
        border: getComputedStyle(side).borderRight,
      },
      pieces,
    }))
  } catch {
    // 浏览器限制会话存储时，仍可按原路径切换。
  }
}

/** 在 DSH 启动脚本之前执行。函数独立于模块变量，便于注入初始文档。 */
export function showModeHandoff(key, mode, readBrand, createLoading) {
  let handoff
  try {
    const saved = sessionStorage.getItem(key)
    if (!saved) return
    sessionStorage.removeItem(key)
    handoff = JSON.parse(saved)
  } catch { return }
  if (handoff?.mode !== mode || handoff.path !== location.pathname || !(handoff.expires > Date.now())) return

  function position(element, box) {
    for (const [key, value] of Object.entries({ left: box.x, top: box.y, width: box.width, height: box.height })) {
      if (Number.isFinite(value)) element.style[key] = value + 'px'
    }
  }

  const cover = document.createElement('div')
  cover.setAttribute('data-codex-mode-arrival', '')
  cover.setAttribute('aria-hidden', 'true')
  const left = Number.isFinite(handoff.workspaceLeft) ? handoff.workspaceLeft : 0
  const style = document.documentElement.style
  const originalBackground = style.backgroundColor
  if (CSS.supports('color', handoff.background)) {
    cover.style.backgroundColor = handoff.background
    style.backgroundColor = handoff.background
  }
  style.setProperty('--codex-mode-workspace-left', left + 'px')
  if (handoff.sidebar) {
    const side = document.createElement('div')
    side.style.position = 'absolute'
    side.style.boxSizing = 'border-box'
    if (CSS.supports('color', handoff.sidebar.background)) side.style.backgroundColor = handoff.sidebar.background
    side.style.borderRight = handoff.sidebar.border
    position(side, handoff.sidebar)
    cover.append(side)
  }
  const retained = new Map()
  for (const piece of Array.isArray(handoff.pieces) ? handoff.pieces : []) {
    if (!piece?.image || typeof piece.src !== 'string' || !piece.src.startsWith('data:image/svg+xml,')) continue
    const crop = document.createElement('div')
    crop.style.position = 'absolute'
    crop.style.overflow = 'hidden'
    position(crop, piece)
    const picture = document.createElement('img')
    picture.alt = ''
    picture.style.position = 'absolute'
    position(picture, piece.image)
    picture.src = piece.src
    crop.append(picture)
    cover.append(crop)
    retained.set(piece.kind, { crop, piece })
  }
  const labels = {
    plugins: 'Loading plugins…',
    session: 'Loading session…',
    layout: 'Preparing the workspace…',
    ...handoff.labels,
  }
  const loading = createLoading(labels.plugins, handoff.startedAt)
  if (CSS.supports('color', handoff.loadingColor)) loading.style.color = handoff.loadingColor
  if (CSS.supports('color', handoff.loadingBackground)) loading.style.backgroundColor = handoff.loadingBackground
  if (CSS.supports('color', handoff.loadingTitleColor)) {
    loading.style.setProperty('--codex-mode-loading-title-color', handoff.loadingTitleColor)
  }
  const message = loading.querySelector('[data-codex-mode-loading-label]')
  cover.append(loading)
  // 新文档的原生启动包可能挡住 HTML 解析。先把画面接到已存在的根节点。
  ;(document.body ?? document.documentElement).append(cover)
  document.documentElement.setAttribute('data-codex-mode-arriving', '')

  let frame
  let stableSince
  let lastPosition
  let phase = 'plugins'
  const observer = new MutationObserver(schedule)
  const timeout = setTimeout(() => finish(false), 8000)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  schedule()

  function schedule() {
    frame ??= requestAnimationFrame(check)
  }

  function showPhase(next) {
    if (next === phase) return
    phase = next
    message.textContent = labels[next]
  }

  function check(now) {
    frame = undefined
    const root = document.getElementById('root')
    const boot = root?.querySelector('[data-dsh-boot]')
    if (boot && !boot.querySelector('[data-dsh-boot-spinner]')) {
      finish(false)
      return
    }
    const rightbar = root?.querySelector('[data-rightbar-col]')
    const mark = root?.querySelector('[data-codex-mode-mark]')
    if (root?.querySelector('[data-codex-session-loading]')) {
      showPhase('session')
      lastPosition = undefined
      return
    }
    if (boot || !rightbar || !mark) {
      if (boot) showPhase('plugins')
      else if (phase === 'session') showPhase('layout')
      lastPosition = undefined
      return
    }
    showPhase('layout')
    const positions = readBrand(root).flatMap(([kind, element]) => {
      const box = element?.getBoundingClientRect()
      return box?.width && box.height ? [{ kind, x: box.x, y: box.y, width: box.width, height: box.height }] : []
    })
    const workspace = rightbar.previousElementSibling?.getBoundingClientRect()
    const signature = [workspace?.x, workspace?.y, workspace?.width,
      ...positions.flatMap(box => [box.kind, box.x, box.y, box.width, box.height])].join(',')
    if (signature !== lastPosition) {
      lastPosition = signature
      stableSince = now
    }
    // 主布局先挂载，插件注册的工具栏、会话选择等仍可能改变品牌位置。
    if (now - stableSince < 160) schedule()
    else finish(true, positions)
  }

  function finish(fade, positions = []) {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearTimeout(timeout)
    const remove = () => {
      document.documentElement.removeAttribute('data-codex-mode-arriving')
      style.removeProperty('--codex-mode-workspace-left')
      if (style.backgroundColor === cover.style.backgroundColor) style.backgroundColor = originalBackground
      cover.remove()
    }
    if (!fade || matchMedia('(prefers-reduced-motion: reduce)').matches) return remove()
    const align = []
    for (const box of positions) {
      const old = retained.get(box.kind)
      if (!old) continue
      const dx = old.piece.x - box.x
      const dy = old.piece.y - box.y
      position(old.crop, box)
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        align.push(old.crop.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: 140, easing: 'ease-out' },
        ).finished)
      }
    }
    Promise.allSettled(align).then(() =>
      cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished,
    ).then(remove, remove)
  }
}
