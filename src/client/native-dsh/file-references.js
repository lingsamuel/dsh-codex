import { readPage } from '../api.js'
import { remoteFailure } from './catalog.js'

/** 将 DSH 原生 @ 菜单接到 Codex 的文件和会话候选。 */
export function installFileReferences(ctx) {
  ctx.inject(['inputTriggers'], scope => scope.effect(() => {
    const triggers = scope.inputTriggers
    const serialize = triggers.serializeReference
    async function serializeReference(source, ref, signal) {
      const text = await serialize.call(this, source, ref, signal)
      // DSH 为下钻保留目录的开引号。发送已选引用时要闭合，历史才能按完整路径显示。
      return source === 'reference' && text.startsWith('@"') && text.endsWith('/') ? `${text}"` : text
    }
    triggers.serializeReference = serializeReference
    return () => { if (triggers.serializeReference === serializeReference) triggers.serializeReference = serialize }
  }))
  const fileKey = 'remote.fileReferences'
  const sessionKey = 'remote.sessionReferenceResolver'
  ctx.inject([fileKey, sessionKey], scope => scope.effect(() => {
    const files = scope.get(fileKey)
    const sessions = scope.get(sessionKey)
    const originalList = Object.getOwnPropertyDescriptor(files, 'list')
    const originalCandidates = Object.getOwnPropertyDescriptor(sessions, 'candidates')
    async function list(threadId, query, signal) {
      try {
        const value = await readPage('file-references', { threadId, query }, signal)
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: remoteFailure(error.message) }
      }
    }
    async function candidates(threadId, query, signal) {
      try {
        const value = await readPage('thread-references', { threadId, query }, signal)
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: remoteFailure(error.message) }
      }
    }
    Object.defineProperty(files, 'list', { configurable: true, enumerable: true, value: list })
    Object.defineProperty(sessions, 'candidates', { configurable: true, enumerable: true, value: candidates })
    return () => {
      for (const [remote, key, method, previous] of [[files, 'list', list, originalList], [sessions, 'candidates', candidates, originalCandidates]]) {
        if (Object.getOwnPropertyDescriptor(remote, key)?.value !== method) continue
        if (previous) Object.defineProperty(remote, key, previous)
        else Reflect.deleteProperty(remote, key)
      }
    }
  }))
}
