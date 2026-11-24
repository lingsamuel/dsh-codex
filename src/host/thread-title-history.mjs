import { join } from 'node:path'
import { iterateCodexPages } from './app-server.mjs'
import { createDefaultPreference } from './default-preference.mjs'
import { readThreadTurns } from './live-history.mjs'

function titleEntry(stored) {
  // 旧版本只保存最后一次自动命名。读到旧格式时仍保留标题的自动管理资格。
  return typeof stored === 'string' ? { name: stored } : stored ?? {}
}

function titleNotes(updates = []) {
  return updates.filter(update => update.source === undefined).map(({ oldManaged, ...note }) => note)
}

/** 在同一份 Profile 数据中记录拟标题请求和最新自动标题，展示开关只过滤读回。 */
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
    return visible ? titleNotes((await read(threadId)).updates) : []
  }

  function notify(threadId, updates) {
    if (!visible) return
    const notes = titleNotes(updates)
    for (const observer of observers) if (observer.threadId === threadId) observer.publish(notes)
  }

  async function forkTitle(request, threadId, branch, restoreManual) {
    const entry = await read(threadId)
    let name = branch.name
    let managed = Boolean(name && entry.name === name)
    const changes = (entry.updates ?? []).filter(change => Object.hasOwn(change, 'oldManaged'))
    if (!name || (!restoreManual && !managed) || changes.at(-1)?.newTitle !== name) return

    // 以 Codex 实际保留的轮次为准，回退过的轮次 ID 也可能仍留在标题记录中。
    const remaining = new Set(changes.map(change => change.turnId))
    remaining.delete(null)
    const retained = new Set([null])
    if (remaining.size) {
      const pages = iterateCodexPages(cursor => readThreadTurns(request, {
        threadId: branch.id, limit: 100, itemsView: 'notLoaded', ...(cursor != null && { cursor }),
      }))
      for await (const { data } of pages) {
        for (const turn of data) if (remaining.delete(turn.id)) retained.add(turn.id)
        if (!remaining.size) break
      }
    }

    let end = changes.length
    while (end > 0) {
      const change = changes[end - 1]
      // 外部改名可以在两次网页写入之间打断记录，无法核对时保留原生分支名称。
      if (change.newTitle !== name) return
      if (retained.has(change.turnId)) break
      name = change.oldTitle
      managed = change.oldManaged
      end--
    }
    // 已回退轮次的标题仍可能连接前后两次改名，保留变更链以便从分支再次恢复。
    if (name) return { name, managed, changes: changes.slice(0, end) }
  }

  return {
    list, forkTitle,
    async managedName(threadId) { return (await read(threadId)).name },
    async recordName(threadId, turnId, oldTitle, newTitle, source) {
      await update(threadId, entry => ({
        name: source === 'automatic' ? newTitle : undefined,
        updates: [...entry.updates ?? [], { turnId, oldTitle, newTitle, source,
          oldManaged: Boolean(oldTitle && oldTitle === entry.name) }],
      }))
    },
    async inherit(threadId, { name, managed, changes }) {
      // 继承标题变更即可。源会话的模型请求注记只显示在发出请求的会话。
      await update(threadId, () => ({
        name: managed ? name : undefined,
        updates: changes.map(change => ({ ...change, source: change.source ?? 'automatic' })),
      }))
    },
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
        const updates = entry.updates.with(index, { turnId: entry.updates[index].turnId, ...result,
          ...(result.outcome === 'renamed' && { oldManaged: Boolean(result.oldTitle && result.oldTitle === entry.name) }) })
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
