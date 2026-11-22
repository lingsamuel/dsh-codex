import { isAbsolute } from 'node:path'
import { CodexRpcError, withCodexReader } from './app-server.mjs'
import { userInputText } from '../shared/user-input.js'
import { threadReferencesIn } from '../shared/thread-references.js'

const nameContinuation = /^[\p{L}\p{M}\p{N}_:-]/u
const otherToolLink = /^\]\s*\(\s*(app|mcp|plugin):\/\//

function mentionedSkills(text, candidates) {
  const names = [...candidates].sort((left, right) => right.length - left.length)
  const mentioned = new Set()
  const references = threadReferencesIn(text)
  for (const { index } of text.matchAll(/\$/g)) {
    if (references.some(ref => index >= ref.start && index < ref.end)) continue
    // 命名空间和 Unicode 名称按 Codex 提供的原字符串查找，并优先使用完整的长名称。
    const start = index + 1
    const name = names.find(candidate => text.startsWith(candidate, start)
      && !nameContinuation.test(text.slice(start + candidate.length)))
    if (!name || (text[index - 1] === '[' && otherToolLink.test(text.slice(start + name.length)))) continue
    mentioned.add(name)
  }
  return mentioned
}

async function readEnabledSkills(request, cwd) {
  if (!cwd) return []
  const { data } = await request('skills/list', { cwds: [cwd] })
  return (data[0]?.skills ?? []).filter(skill => skill.enabled)
}

function firstSkillsByName(skills) {
  const first = new Map()
  for (const skill of skills) {
    // Codex 对未绑定路径的同名技能按原生目录顺序取第一个启用项。
    if (!first.has(skill.name)) first.set(skill.name, skill)
  }
  return first
}

/** 从原生目录补充结构化技能，并保留原生输入的正文、顺序和附件。 */
export async function resolveInputSkills(request, input, readCwd, previousText = '') {
  const text = userInputText(input)
  if (!text.includes('$') && !previousText.includes('$')) return input
  const skills = text.includes('$') ? await readEnabledSkills(request, await readCwd()) : []
  const first = firstSkillsByName(skills)
  const names = mentionedSkills(text, first.keys())
  const previousCandidates = new Set(first.keys())
  for (const part of input) if (part.type === 'skill') previousCandidates.add(part.name)
  const previousNames = mentionedSkills(previousText, previousCandidates)
  const usedNames = new Set()
  const usedPaths = new Set()
  const resolved = input.filter(part => {
    if (part.type !== 'skill') return true
    // 编辑时保留仍有效的原生绑定（例如 CLI 选择的同名项），随正文删除已移除的引用。
    if (previousNames.has(part.name) && (!names.has(part.name)
      || !skills.some(skill => skill.name === part.name && skill.path === part.path))) return false
    usedNames.add(part.name)
    usedPaths.add(part.path)
    return true
  })
  for (const { name, path } of first.values()) {
    if (!names.has(name) || usedNames.has(name) || usedPaths.has(path)) continue
    resolved.push({ type: 'skill', name, path })
    usedPaths.add(path)
  }
  return resolved
}

/** 使用草稿工作目录或原生会话工作目录读取技能。无需恢复线程或取消归档。 */
export function createSkillsRoute(socketPath, ownerSignal) {
  const headers = { 'Cache-Control': 'no-store' }
  return {
    path: '/api/codex/skills', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const { searchParams } = new URL(request.url)
      const threadId = searchParams.get('threadId')
      const cwd = searchParams.get('cwd')
      if (!threadId?.trim() && !isAbsolute(cwd ?? '')) {
        return Response.json({ error: '请选择有效的工作目录。' }, { status: 400, headers })
      }
      const signal = ownerSignal ? AbortSignal.any([request.signal, ownerSignal]) : request.signal
      try {
        const skills = await withCodexReader(socketPath, signal, async rpc => {
          const directory = threadId?.trim() ? (await rpc('thread/read', { threadId })).thread.cwd : cwd
          const enabled = await readEnabledSkills(rpc, directory)
          return Array.from(firstSkillsByName(enabled).values(), skill => ({
            name: skill.name, path: skill.path, label: skill.interface?.displayName ?? undefined,
            description: skill.interface?.shortDescription || skill.shortDescription || skill.description,
          }))
        })
        return Response.json({ skills }, { headers })
      } catch (error) {
        if (error instanceof CodexRpcError) {
          return Response.json({ error: error.message }, { status: error.code === -32602 ? 400 : 502, headers })
        }
        return Response.json({ error: '无法读取 Codex 技能目录。' }, { status: 503, headers })
      }
    },
  }
}
