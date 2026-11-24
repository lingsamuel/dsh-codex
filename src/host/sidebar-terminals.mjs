import { isLocalSessionId } from '../shared/local-session.js'
import { codexTerminalDescriptors, codexTerminalNamespace, decodeTerminalScope } from '../shared/sidebar-terminals.js'
import { resolveWorktreeCwd, validateWorktreeSelection } from './git-worktrees.mjs'
import { isWorkspaceDirectory } from './workspace-paths.mjs'

/** 将同一个控制器中的草稿 PTY 引用交接给首发成功的原生线程。 */
export function createSidebarTerminalOwners() {
  const adopted = new Set()
  const drafts = new Map()
  const followers = new Map()
  const terminals = new Map()
  const keys = id => [id, ...(drafts.get(id) ?? [])]
  return {
    associate(draftId, threadId) {
      if (adopted.has(draftId)) return
      adopted.add(draftId)
      const linked = drafts.get(threadId) ?? new Set()
      linked.add(draftId)
      drafts.set(threadId, linked)
      for (const update of followers.get(threadId) ?? []) update()
    },
    keys,
    owner(id, terminalId) {
      return keys(id).find(key => terminals.get(key)?.has(terminalId)) ?? id
    },
    remember(id, terminalId) {
      const known = terminals.get(id) ?? new Set()
      known.add(terminalId)
      terminals.set(id, known)
    },
    follow(id, update) {
      const listeners = followers.get(id) ?? new Set()
      listeners.add(update)
      followers.set(id, listeners)
      return () => {
        listeners.delete(update)
        if (listeners.size === 0) followers.delete(id)
      }
    },
  }
}

function listTerminals(controller, owners, id) {
  const listed = new Map()
  for (const key of owners.keys(id)) {
    for (const info of controller.list(key)) {
      if (!listed.has(info.id)) listed.set(info.id, info)
    }
  }
  return [...listed.values()]
}

/** 保留官方的列表订阅，也让已经在看的线程收到新增的草稿终端。 */
async function* watchTerminals(controller, owners, id, signal) {
  const subscription = new AbortController()
  const lifetime = AbortSignal.any([signal, subscription.signal])
  const tasks = new Map()
  let failure, wake, emitted
  let dirty = true
  const changed = () => {
    dirty = true
    wake?.()
  }
  const refresh = () => {
    for (const key of owners.keys(id)) {
      if (tasks.has(key)) continue
      const task = (async () => {
        for await (const _ of controller.watch(key, lifetime)) changed()
      })().catch(error => { failure = error; changed() })
      tasks.set(key, task)
    }
  }
  const unsubscribe = owners.follow(id, refresh)
  lifetime.addEventListener('abort', changed, { once: true })
  try {
    refresh()
    while (!lifetime.aborted) {
      if (!dirty) await new Promise(resolve => { wake = resolve })
      wake = undefined
      dirty = false
      if (lifetime.aborted) return
      if (failure) throw failure
      const current = listTerminals(controller, owners, id)
      if (emitted?.length === current.length && current.every((info, index) => emitted[index] === info)) continue
      emitted = current
      yield current
    }
  } finally {
    unsubscribe()
    subscription.abort()
    lifetime.removeEventListener('abort', changed)
    await Promise.all(tasks.values())
  }
}

/** 在独立的终端控制器上暴露 Codex 路由，沿用 DSH 的 PTY、输入输出和回收逻辑。 */
export async function installCodexSidebarTerminals(ctx, { owners, readWorkspace, resolveDraftWorktree, available }) {
  const [{ TerminalController }, { TYPERT }, { RemoteError, TypertRemoteService }] = await Promise.all([
    ctx.loader.import('@deepseek-ai/dsh-api-terminal-controller'),
    ctx.loader.import('@deepseek-ai/dsh-api-terminal-controller/typert'),
    ctx.loader.import('@deepseek-ai/dsh-typert-protocol'),
  ])
  const isolation = Symbol('Codex terminalController')
  const terminalScope = ctx.isolate('terminalController', isolation).isolate('workingDirectory')
  terminalScope.provide('workingDirectory', {
    get: session => session.cwd,
    ensure: (agent, signal) => readCwd(agent.session, signal, true),
  })
  await terminalScope.plugin(TerminalController)

  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())

  async function requireDirectory(cwd) {
    if (typeof cwd !== 'string' || !await isWorkspaceDirectory(cwd)) throw new Error('终端工作目录不可用。')
    return cwd
  }

  async function readCwd({ id, cwd, worktree }, signal, create = false) {
    if (!isLocalSessionId(id)) return requireDirectory(await readWorkspace(id, signal))
    await requireDirectory(cwd)
    if (worktree == null) return cwd
    const selection = validateWorktreeSelection(worktree)
    if (create) return requireDirectory(await resolveDraftWorktree(id, cwd, selection, signal))
    if (selection.kind === 'existing') return requireDirectory(await resolveWorktreeCwd(cwd, selection, signal))
    return cwd
  }

  const agent = (id, session) => ({ id, ctx: terminalScope, session })
  class CodexTerminalService extends TypertRemoteService {
    constructor() { super(ctx, codexTerminalNamespace) }

    controller() {
      const invocation = this.ctx.invocation
      if (invocation?.peer.principal.kind !== 'owner') {
        throw new RemoteError('remote-access/denied', '只有 Host 所有者可以使用终端。', {
          action: `${codexTerminalNamespace}/${invocation?.request.method ?? ''}`, reason: 'owner-required',
        })
      }
      if (!available()) throw new RemoteError('terminal/unavailable', 'Codex 终端不可用。', {})
      // 在当前调用作用域取控制器，让 attach 继续读取 Gateway 的上行流。
      return this.ctx.isolate('terminalController', isolation).get('terminalController')
    }

    async environment(value, signal) {
      const controller = this.controller()
      const scope = decodeTerminalScope(value)
      const cwd = await readCwd(scope, signal)
      return controller.environment(agent(scope.id, { cwd }), signal)
    }

    async shells(value, signal) {
      const controller = this.controller()
      const scope = decodeTerminalScope(value)
      await readCwd(scope, signal)
      return controller.shells(agent(scope.id), signal)
    }

    create(value, request, signal) {
      const controller = this.controller()
      const scope = decodeTerminalScope(value)
      const owner = owners.owner(scope.id, request.id)
      owners.remember(owner, request.id)
      return controller.create(agent(owner, scope), request, signal)
    }

    list(id) {
      return listTerminals(this.controller(), owners, id)
    }

    watch(id, signal) {
      return watchTerminals(this.controller(), owners, id, AbortSignal.any([signal, lifetime.signal]))
    }

    attach(id, terminalId, signal) {
      return this.controller().attach(agent(owners.owner(id, terminalId)), terminalId, signal)
    }

    retain(id, terminalId, signal) {
      return this.controller().retain(owners.owner(id, terminalId), terminalId, signal)
    }

    rename(id, terminalId, title) {
      return this.controller().rename(agent(owners.owner(id, terminalId)), terminalId, title)
    }

    close(id, terminalId) {
      const controller = this.controller()
      const owner = owners.owner(id, terminalId)
      owners.remember(owner, terminalId)
      return controller.close(agent(owner), terminalId)
    }
  }
  new CodexTerminalService()
  ctx.typert.register({
    package: 'dsh-for-codex',
    face: 'host',
    schemas: [],
    invocations: codexTerminalDescriptors(TYPERT.invocations),
    model: { services: [], events: [], objects: [] },
  })
}
