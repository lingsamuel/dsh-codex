import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  IconCodeOutlineRegular, IconEditOutlineRegular, IconFlatListOutlineRegular, IconGoalOutlineRegular,
  IconInfoOutlineRegular, IconPlanOutlineRegular, IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useSyncExternalStore } from 'react'
import { CommandDetails } from './command-details.jsx'
import { createPlanAction, PlanChip } from './plan-command.jsx'

const overlay = 'conversation.input.overlay'
const planSlot = 'conversation.input.plan'
const renameMenu = 'sidebar.workspaces.session.menu.item'
const locale = 'codex.commands'
const copy = {
  zh: {
    status: '会话状态', 'status.description': '查看会话配置和上下文占用',
    goal: '目标', 'goal.description': '查看和管理当前会话的目标',
    compact: '压缩上下文', 'compact.description': '压缩当前会话的上下文',
    review: '审查改动', 'review.description': '在当前会话中发起代码审查',
    plan: '计划模式', 'plan.description': '查看并设置后续轮次的协作模式',
    ps: '后台终端', 'ps.description': '列出当前会话的后台终端',
    rename: '重命名', 'rename.description': '重命名当前会话',
    close: '关闭', loading: '正在读取…', model: '模型', effort: '推理强度', session: '会话 ID', cwd: '工作目录',
    context: '上下文占用', used: '已使用 token', budget: 'token 预算', noGoal: '此会话没有目标。',
    active: '进行中', paused: '暂停', blocked: '受阻', usageLimited: '达到用量限制', budgetLimited: '达到预算', complete: '已完成',
    noTerminals: '此会话没有后台终端。', terminalsUnavailable: '此会话的后台终端列表不可用。',
    cancel: '取消', pending: '正在提交给 Codex…', awaitingMode: '已提交，正在等待 Codex 确认模式…',
    readOnly: '此会话仅供查看。', unavailable: '会话历史未就绪。',
    busy: '此会话正在运行，请在轮次结束后重试。', blank: '此会话还没有可压缩的历史。',
    modesUnavailable: 'Codex 未提供可用的协作模式。', goalUnavailable: '此会话无法读取目标。',
    'compact.detail': 'Codex 将压缩当前会话的上下文。进度和结果会显示在聊天中。',
    'compact.run': '压缩', 'compact.run.unarchive': '取消归档并压缩',
    'review.detail': '选择审查范围。结果会显示在当前聊天中。',
    'review.target': '审查范围', 'review.uncommittedChanges': '未提交的改动', 'review.baseBranch': '相对指定分支的改动',
    'review.commit': '指定提交', 'review.custom': '自定义审查', 'review.branch': '分支名', 'review.sha': '提交 ID',
    'review.instructions': '审查要求', 'review.run': '开始审查', 'review.run.unarchive': '取消归档并审查',
    'plan.current': '当前模式', 'plan.select': '选择模式', 'plan.default': '默认', 'plan.plan': '计划',
    'plan.unknown': '未确认', 'plan.apply': '应用', 'plan.apply.unarchive': '取消归档并应用',
    'plan.exit': '退出计划模式', 'plan.exit.unarchive': '取消归档并退出计划模式', 'plan.exiting': '正在退出…',
    'plan.changeFailed': '模式切换失败',
    'goal.objective': '目标内容', 'goal.optionalBudget': 'token 预算（选填）', 'goal.invalidBudget': '请输入正整数。',
    'goal.read.unarchive': '取消归档并读取目标',
    'goal.create': '创建目标', 'goal.create.unarchive': '取消归档并创建目标',
    'goal.pause': '暂停目标', 'goal.pause.unarchive': '取消归档并暂停目标',
    'goal.resume': '恢复目标', 'goal.resume.unarchive': '取消归档并恢复目标',
    'goal.clear': '清除目标', 'goal.clear.unarchive': '取消归档并清除目标',
    'goal.confirmClear': '清除会移除当前目标，目标的进度和用量将不再保留。确定清除？',
  },
  en: {
    status: 'Session status', 'status.description': 'View session configuration and context usage',
    goal: 'Goal', 'goal.description': 'View and manage the current session goal',
    compact: 'Compact context', 'compact.description': 'Compact the current session context',
    review: 'Review changes', 'review.description': 'Start a code review in the current session',
    plan: 'Plan mode', 'plan.description': 'View and set the collaboration mode for future turns',
    ps: 'Background terminals', 'ps.description': 'List background terminals for the current session',
    rename: 'Rename', 'rename.description': 'Rename the current session',
    close: 'Close', loading: 'Loading…', model: 'Model', effort: 'Reasoning effort', session: 'Session ID', cwd: 'Working directory',
    context: 'Context usage', used: 'Tokens used', budget: 'Token budget', noGoal: 'This session has no goal.',
    active: 'Active', paused: 'Paused', blocked: 'Blocked', usageLimited: 'Usage limited', budgetLimited: 'Budget limited', complete: 'Complete',
    noTerminals: 'This session has no background terminals.', terminalsUnavailable: 'The background terminal list is unavailable for this session.',
    cancel: 'Cancel', pending: 'Submitting to Codex…', awaitingMode: 'Submitted. Waiting for Codex to confirm the mode…',
    readOnly: 'This session is read-only.', unavailable: 'Session history is unavailable.',
    busy: 'This session is running. Try again after the turn ends.', blank: 'This session has no history to compact.',
    modesUnavailable: 'Codex did not provide any collaboration modes.', goalUnavailable: 'The goal is unavailable for this session.',
    'compact.detail': 'Codex will compact the context for this session. Progress and results appear in the chat.',
    'compact.run': 'Compact', 'compact.run.unarchive': 'Unarchive and compact',
    'review.detail': 'Choose what to review. The results appear in this chat.',
    'review.target': 'Review target', 'review.uncommittedChanges': 'Uncommitted changes', 'review.baseBranch': 'Changes against a base branch',
    'review.commit': 'Specific commit', 'review.custom': 'Custom review', 'review.branch': 'Branch name', 'review.sha': 'Commit ID',
    'review.instructions': 'Review instructions', 'review.run': 'Start review', 'review.run.unarchive': 'Unarchive and review',
    'plan.current': 'Current mode', 'plan.select': 'Select mode', 'plan.default': 'Default', 'plan.plan': 'Plan',
    'plan.unknown': 'Unconfirmed', 'plan.apply': 'Apply', 'plan.apply.unarchive': 'Unarchive and apply',
    'plan.exit': 'Exit Plan mode', 'plan.exit.unarchive': 'Unarchive and exit Plan mode', 'plan.exiting': 'Exiting…',
    'plan.changeFailed': 'Could not change mode',
    'goal.objective': 'Objective', 'goal.optionalBudget': 'Token budget (optional)', 'goal.invalidBudget': 'Enter a positive whole number.',
    'goal.read.unarchive': 'Unarchive and read goal',
    'goal.create': 'Create goal', 'goal.create.unarchive': 'Unarchive and create goal',
    'goal.pause': 'Pause goal', 'goal.pause.unarchive': 'Unarchive and pause goal',
    'goal.resume': 'Resume goal', 'goal.resume.unarchive': 'Unarchive and resume goal',
    'goal.clear': 'Clear goal', 'goal.clear.unarchive': 'Unarchive and clear goal',
    'goal.confirmClear': 'Clear this goal and its progress and usage?',
  },
}

function CommandOverlay({ controls, ...props }) {
  return controls && <CommandDialog {...props} {...controls} />
}

function CommandDialog({ commandRequest, session, ...props }) {
  const request = useSyncExternalStore(commandRequest.subscribe, commandRequest.getSnapshot)
  useEffect(() => () => commandRequest.set(null), [commandRequest])
  if (!request) return null
  const onClose = () => {
    if (commandRequest.getSnapshot() === request) commandRequest.set(null)
  }
  return <CommandDetails {...props} {...request} session={session} sessionId={session.sessionId}
    key={`${session.sessionId}:${request.command}`} onClose={onClose} />
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
    const controls = new WeakMap()
    function controlsFor(sessionId) {
      const binding = sessions.binding(sessionId)
      if (!binding) return
      if (!controls.has(binding)) {
        const { session } = binding
        controls.set(binding, { session, commandRequest: createSnapshotStore(null), planAction: createPlanAction(session) })
      }
      return controls.get(binding)
    }
    const rename = () => ctx.slots.entries(renameMenu).find(entry => entry.options.id === 'rename')?.inject().requestSessionRename
    const available = ({ sessionId }) => Boolean(sessions.binding(sessionId))
    const commands = [
      { name: 'status', icon: IconInfoOutlineRegular },
      { name: 'goal', icon: IconGoalOutlineRegular },
      { name: 'compact', icon: IconFlatListOutlineRegular },
      { name: 'review', icon: IconSearchOutlineRegular },
      { name: 'plan', icon: IconPlanOutlineRegular },
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
    for (const { name, icon, available: canRun = available, run = ({ sessionId }) => controlsFor(sessionId)?.commandRequest.set({ command: name }) } of commands) {
      scope.effect(() => commandUi.register({
        name, icon, label: () => t(name), description: () => t(`${name}.description`), available: canRun,
        ui: { kind: 'action', run },
      }))
    }
    scope.slots.inject(overlay, () => scope.slots.register({
      name: overlay, id: 'codex-command-details', order: 30, locale,
      inject: sessionId => ({ controls: controlsFor(sessionId) }),
    }, CommandOverlay))
    scope.slots.inject(planSlot, () => scope.slots.register({
      name: planSlot, locale,
      inject: sessionId => ({ controls: controlsFor(sessionId) }),
    }, PlanChip))
  })
}
