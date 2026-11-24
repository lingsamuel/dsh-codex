import { isLocalSessionId } from './local-session.js'

export const codexTerminalNamespace = 'codexTerminal'

/** 复用终端的编解码器。Codex 会话身份由自己的 Host 服务解析。 */
export function codexTerminalDescriptors(descriptors) {
  return descriptors.filter(descriptor => descriptor.namespace === 'terminal').map(descriptor => {
    const { scope, input, invoke, ...native } = descriptor
    return {
      ...native,
      id: `dsh-for-codex#${codexTerminalNamespace}/${native.method}`,
      service: codexTerminalNamespace,
      namespace: codexTerminalNamespace,
      parameters: native.parameters.map(parameter => {
        if (parameter.lookup !== 'agent') return parameter
        const { lookup, ...identity } = parameter
        return { ...identity, source: 'json' }
      }),
    }
  })
}

/** 目录和工作树选择随草稿请求传入，原生线程只传其 ID。 */
export function encodeTerminalScope(id, cwd, worktree) {
  return isLocalSessionId(id) ? `${id}:${JSON.stringify({ cwd, worktree })}` : id
}

export function decodeTerminalScope(value) {
  const separator = value.indexOf(':')
  if (separator < 0) return { id: value }
  const id = value.slice(0, separator)
  if (!isLocalSessionId(id)) return { id: value }
  const { cwd, worktree } = JSON.parse(value.slice(separator + 1))
  return { id, cwd, worktree }
}
