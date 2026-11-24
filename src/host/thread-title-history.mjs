import { join } from 'node:path'
import { createDefaultPreference } from './default-preference.mjs'

function titleEntry(stored) {
  // 旧版本只保存最后一次自动命名。读到旧格式时仍保留标题的自动管理资格。
  return typeof stored === 'string' ? { name: stored } : stored ?? {}
}

/** 在同一份 Profile 数据中记录拟题请求和最新自动标题，展示开关只过滤读回。 */
export function createThreadTitleHistory(cacheDirectory) {
  const store = createDefaultPreference(cacheDirectory && join(cacheDirectory, 'web-automatic-titles.json'), 'names')
  const observers = new Set()
  let visible = false

  async function read(threadId) {
    const threads = await store.get()
    return titleEntry(threads && Object.hasOwn(threads, threadId) ? threads[threadId] : undefined)
  }

  async function update(threadId, change) {
    const threads = await store.update(previous => {
      const { [threadId]: saved, ...others } = previous ?? {}
      const next = change(titleEntry(saved))
      const stored = next?.updates?.length ? next : next?.name
      return stored ? { ...others, [threadId]: stored } : others
    })
    return titleEntry(Object.hasOwn(threads, threadId) ? threads[threadId] : undefined)
  }

  async function list(threadId) {
    return visible ? (await read(threadId)).updates ?? [] : []
  }

  function notify(threadId, updates) {
    if (!visible) return
    for (const observer of observers) if (observer.threadId === threadId) observer.publish(updates)
  }

  return {
    list,
    async managedName(threadId) { return (await read(threadId)).name },
    async name(threadId, name) { await update(threadId, entry => ({ ...entry, name })) },
    async releaseName(threadId) {
      await update(threadId, entry => entry.updates?.length ? { updates: entry.updates } : undefined)
    },
    async begin(threadId, turnId) {
      const { updates } = await update(threadId, entry => ({
        ...entry, updates: [...entry.updates ?? [], { turnId, outcome: 'pending' }],
      }))
      notify(threadId, updates)
      // 记录按会话追加，同一轮有多次请求时也能各自更新。
      return updates.length - 1
    },
    async finish(threadId, index, result) {
      const { updates } = await update(threadId, entry => {
        const updates = entry.updates.with(index, { turnId: entry.updates[index].turnId, ...result })
        return { ...entry, updates, ...(result.outcome === 'renamed' && { name: result.newTitle }) }
      })
      notify(threadId, updates)
    },
    show(value) {
      if (value === visible) return
      visible = value
      for (const observer of observers) observer.publish(visible ? undefined : [])
    },
    watch(threadId, send, signal) {
      if (signal.aborted) return
      let revision = 0
      const observer = { threadId, publish(updates) {
        const current = ++revision
        if (updates) send({ type: 'title-history', updates })
        else void list(threadId).then(result => {
          if (!signal.aborted && current === revision) send({ type: 'title-history', updates: result })
        }).catch(() => {})
      } }
      observers.add(observer)
      signal.addEventListener('abort', () => observers.delete(observer), { once: true })
      if (visible) observer.publish()
    },
  }
}
