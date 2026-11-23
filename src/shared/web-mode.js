export const webModePath = '/api/codex/web-mode'
export const webModeNotice = 'dsh-chatgpt-web-mode-notice'
export const defaultWebPreferences = Object.freeze({ coexist: true, exclusive: false, defaultMode: 'dsh' })

export function webModeFor({ coexist, exclusive, defaultMode }, requested) {
  if (exclusive) return 'codex'
  return coexist && (requested === 'dsh' || requested === 'codex') ? requested : defaultMode
}

export function singleCodexFor(settings) {
  return settings.exclusive || !settings.coexist && settings.defaultMode === 'codex'
}

export function canKeepWebPage(settings, patch) {
  return settings.coexist && (settings.exclusive ? patch.exclusive === false : patch.defaultMode !== undefined)
}
