import { join } from 'node:path'
import { defaultHistoryPreferences, isHistoryPreferenceValue } from '../shared/history-preferences.js'
import { createCodexCapabilityRoute, invalidCapabilityRequest } from './codex-capability-route.mjs'
import { createDefaultPreference } from './default-preference.mjs'

const fields = Object.keys(defaultHistoryPreferences)

/** 路由与历史加载共享同一个 Profile 存储实例，保存后下一次打开会话即可读到新值。 */
export function createHistoryPreferences(cacheDirectory) {
  const stored = createDefaultPreference(cacheDirectory && join(cacheDirectory, 'web-history-preferences.json'), 'preferences')

  function normalize(saved) {
    return Object.fromEntries(fields.map(key => [key, isHistoryPreferenceValue(key, saved?.[key])
      ? saved[key] : defaultHistoryPreferences[key]]))
  }

  async function get() {
    return normalize(await stored.get())
  }

  const route = createCodexCapabilityRoute('history-preferences', undefined, get, async (body, signal) => {
    const changed = fields.filter(key => Object.hasOwn(body, key))
    if (!changed.length || !changed.every(key => isHistoryPreferenceValue(key, body[key]))) {
      throw invalidCapabilityRequest('会话历史加载设置无效。')
    }
    const patch = Object.fromEntries(changed.map(key => [key, body[key]]))
    return stored.update(previous => {
      signal.throwIfAborted()
      return { ...normalize(previous), ...patch }
    })
  })

  return { route, get }
}
