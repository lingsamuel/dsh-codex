import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconCodeOutlineRegular, IconEditOutlineRegular, IconGoalOutlineRegular, IconInfoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useSyncExternalStore } from 'react'
import { CommandDetails } from './command-details.jsx'

const overlay = 'conversation.input.overlay'
const renameMenu = 'sidebar.workspaces.session.menu.item'
const locale = 'codex.commands'
const copy = {
  zh: {
    status: '会话状态', 'status.description': '查看会话配置和上下文占用',
    goal: '目标', 'goal.description': '查看当前会话的目标',
    ps: '后台终端', 'ps.description': '列出当前会话的后台终端',
    rename: '重命名', 'rename.description': '重命名当前会话',
    close: '关闭', loading: '正在读取…', model: '模型', effort: '推理强度', session: '会话 ID', cwd: '工作目录',
    context: '上下文占用', used: '已使用 token', budget: 'token 预算', noGoal: '此会话没有目标。',
    active: '进行中', paused: '暂停', blocked: '受阻', usageLimited: '达到用量限制', budgetLimited: '达到预算', complete: '已完成',
    noTerminals: '此会话没有后台终端。', terminalsUnavailable: '此会话的后台终端列表不可用。',
  },
  en: {
    status: 'Session status', 'status.description': 'View session configuration and context usage',
    goal: 'Goal', 'goal.description': 'View the current session goal',
    ps: 'Background terminals', 'ps.description': 'List background terminals for the current session',
    rename: 'Rename', 'rename.description': 'Rename the current session',
    close: 'Close', loading: 'Loading…', model: 'Model', effort: 'Reasoning effort', session: 'Session ID', cwd: 'Working directory',
    context: 'Context usage', used: 'Tokens used', budget: 'Token budget', noGoal: 'This session has no goal.',
    active: 'Active', paused: 'Paused', blocked: 'Blocked', usageLimited: 'Usage limited', budgetLimited: 'Budget limited', complete: 'Complete',
    noTerminals: 'This session has no background terminals.', terminalsUnavailable: 'The background terminal list is unavailable for this session.',
  },
}

function CommandOverlay({ commandRequest, ...props }) {
  const command = useSyncExternalStore(commandRequest.subscribe, commandRequest.getSnapshot)
  useEffect(() => () => commandRequest.set(null), [commandRequest])
  if (!command) return null
  return <CommandDetails {...props} key={command} command={command} onClose={() => commandRequest.set(null)} />
}

/** 给 DSH 原生命令菜单贡献 Codex 命令，按触发命令时的会话 ID 执行。 */
export function installCommands(ctx) {
  ctx.effect(() => ctx.locale.register(locale, copy))
  const t = ctx.locale.bind(locale)

  ctx.inject(['commandUi', 'sessions'], scope => {
    const { commandUi, sessions } = scope
    scope.effect(() => {
      // RC2 的客户端命令也会读取 DSH Agent 的命令目录。该 Profile 中的会话都由 Codex 持有。
      const directory = commandUi.directory
      const fetchCommands = directory.fetchCommands
      const codexCatalog = async () => []
      directory.fetchCommands = codexCatalog
      return () => {
        if (directory.fetchCommands === codexCatalog) directory.fetchCommands = fetchCommands
      }
    })
    const requests = new WeakMap()
    function requestFor(sessionId) {
      const binding = sessions.binding(sessionId)
      if (!requests.has(binding)) requests.set(binding, createSnapshotStore(null))
      return requests.get(binding)
    }
    const rename = () => ctx.slots.entries(renameMenu).find(entry => entry.options.id === 'rename')?.inject().requestSessionRename
    const available = ({ sessionId }) => Boolean(sessions.binding(sessionId))
    const commands = [
      { name: 'status', icon: IconInfoOutlineRegular },
      { name: 'goal', icon: IconGoalOutlineRegular },
      { name: 'ps', icon: IconCodeOutlineRegular },
      {
        name: 'rename', icon: IconEditOutlineRegular,
        available: session => available(session) && Boolean(rename()),
        run({ sessionId }) {
          const summary = sessions.list.getSnapshot().byId[sessionId]
          rename()?.(sessionId, summary?.displayTitle ?? '')
        },
      },
    ]
    for (const { name, icon, available: canRun = available, run = ({ sessionId }) => requestFor(sessionId).set(name) } of commands) {
      scope.effect(() => commandUi.register({
        name, icon, label: () => t(name), description: () => t(`${name}.description`), available: canRun,
        ui: { kind: 'action', run },
      }))
    }
    scope.slots.inject(overlay, () => scope.slots.register({
      name: overlay, id: 'codex-command-details', order: 30, locale,
      inject: sessionId => ({ commandRequest: requestFor(sessionId) }),
    }, CommandOverlay))
  })
}
