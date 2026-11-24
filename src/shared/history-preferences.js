export const defaultHistoryPreferences = Object.freeze({
  firstItems: 1000,
  firstMiB: 1,
  openTurns: 15,
  manualTurns: 15,
  prefetch: true,
})

const bytesPerMiB = 1024 ** 2
export const historyPreferenceLimits = {
  firstItems: { min: 1, max: Number.MAX_SAFE_INTEGER, step: 1 },
  firstMiB: { min: 1 / bytesPerMiB, max: Number.MAX_SAFE_INTEGER / bytesPerMiB, step: 'any' },
  openTurns: { min: 3, max: Number.MAX_SAFE_INTEGER, step: 1 },
  manualTurns: { min: 1, max: Number.MAX_SAFE_INTEGER, step: 1 },
}

/** 浏览器和 Host 共用范围校验，使条目及轮数保持整数，体积预算可用小数。 */
export function isHistoryPreferenceValue(key, value) {
  if (key === 'prefetch') return typeof value === 'boolean'
  const { min, max, step } = historyPreferenceLimits[key]
  return Number.isFinite(value) && value >= min && value <= max && (step === 'any' || Number.isSafeInteger(value))
}
