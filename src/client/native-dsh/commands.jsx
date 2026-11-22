import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  IconCodeOutlineRegular, IconDownloadOutlineRegular, IconEditOutlineRegular, IconFlatListOutlineRegular, IconGoalOutlineRegular,
  IconInfoOutlineRegular, IconPlanOutlineRegular, IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useSyncExternalStore } from 'react'
import { CommandDetails } from './command-details.jsx'
import { createPlanAction, PlanChip } from './plan-command.jsx'
import { GoalChip, GoalReplacement, installGoalBar } from './goal-command.jsx'
import { commandUnavailable } from './command-action.jsx'

const overlay = 'conversation.input.overlay'
const planSlot = 'conversation.input.plan'
const goalSlot = 'conversation.input.left'
const renameMenu = 'sidebar.workspaces.session.menu.item'
const locale = 'codex.commands'
const copy = {
  zh: {
    status: '会话状态', 'status.description': '查看会话配置和上下文占用',
    goal: '目标', 'goal.description': '将下一条输入提交为 Codex 目标',
    compact: '压缩上下文', 'compact.description': '压缩当前会话的上下文',
    review: '审查改动', 'review.description': '在当前会话中发起代码审查',
    plan: '计划模式', 'plan.description': '切换计划模式',
    ps: '后台终端', 'ps.description': '列出当前会话的后台终端',
    export: '导出会话', 'export.description': '将已保存的会话导出为 Markdown',
    'export.copy': '复制 Markdown', 'export.download': '下载 Markdown', 'export.copied': '已复制 Markdown。',
    'export.copyFailed': '无法写入剪贴板，可以下载 Markdown。',
    rename: '重命名', 'rename.description': '重命名当前会话',
    close: '关闭', loading: '正在读取…', model: '模型', effort: '推理强度', session: '会话 ID', cwd: '工作目录',
    context: '上下文占用', used: '已使用 token', budget: 'token 预算',
    noTerminals: '此会话没有后台终端。', terminalsUnavailable: '此会话的后台终端列表不可用。',
    cancel: '取消', pending: '正在提交给 Codex…', awaitingMode: '已提交，正在等待 Codex 确认模式…',
    readOnly: '此会话仅供查看。', unavailable: '会话历史未就绪。',
    busy: '此会话正在运行，请在轮次结束后重试。', blank: '此会话还没有可压缩的历史。',
    'compact.detail': 'Codex 将压缩当前会话的上下文。进度和结果会显示在聊天中。',
    'compact.run': '压缩', 'compact.run.unarchive': '取消归档并压缩',
    'review.detail': '选择审查范围。结果会显示在当前聊天中。',
    'review.target': '审查范围', 'review.uncommittedChanges': '未提交的改动', 'review.baseBranch': '相对指定分支的改动',
    'review.commit': '指定提交', 'review.custom': '自定义审查', 'review.branch': '分支名', 'review.sha': '提交 ID',
    'review.instructions': '审查要求', 'review.run': '开始审查', 'review.run.unarchive': '取消归档并审查',
    'plan.exit': '退出计划模式', 'plan.enter.unarchive': '取消归档并进入计划模式', 'plan.exit.unarchive': '取消归档并退出计划模式',
    'plan.changeFailed': '模式切换失败',
    'goal.exit': '退出目标输入模式', 'goal.budget': '设置预算', 'goal.optionalBudget': 'token 预算（选填）',
    'goal.replace': '替换目标', 'goal.confirmReplace': '将以输入栏正文替换当前目标。',
    'goal.resumeBudget': '目标的 token 预算已用完。可通过 /goal 设置新的预算。',
    'goal.resumeBlocked': 'Codex 未能继续目标，请查看当前状态。',
  },
  en: {
    status: 'Session status', 'status.description': 'View session configuration and context usage',
    goal: 'Goal', 'goal.description': 'Submit the next input as a Codex goal',
    compact: 'Compact context', 'compact.description': 'Compact the current session context',
    review: 'Review changes', 'review.description': 'Start a code review in the current session',
    plan: 'Plan mode', 'plan.description': 'Toggle Plan mode',
    ps: 'Background terminals', 'ps.description': 'List background terminals for the current session',
    export: 'Export session', 'export.description': 'Export the saved conversation as Markdown',
    'export.copy': 'Copy Markdown', 'export.download': 'Download Markdown', 'export.copied': 'Markdown copied.',
    'export.copyFailed': 'Could not write to the clipboard. Download the Markdown instead.',
    rename: 'Rename', 'rename.description': 'Rename the current session',
    close: 'Close', loading: 'Loading…', model: 'Model', effort: 'Reasoning effort', session: 'Session ID', cwd: 'Working directory',
    context: 'Context usage', used: 'Tokens used', budget: 'Token budget',
    noTerminals: 'This session has no background terminals.', terminalsUnavailable: 'The background terminal list is unavailable for this session.',
    cancel: 'Cancel', pending: 'Submitting to Codex…', awaitingMode: 'Submitted. Waiting for Codex to confirm the mode…',
    readOnly: 'This session is read-only.', unavailable: 'Session history is unavailable.',
    busy: 'This session is running. Try again after the turn ends.', blank: 'This session has no history to compact.',
    'compact.detail': 'Codex will compact the context for this session. Progress and results appear in the chat.',
    'compact.run': 'Compact', 'compact.run.unarchive': 'Unarchive and compact',
    'review.detail': 'Choose what to review. The results appear in this chat.',
    'review.target': 'Review target', 'review.uncommittedChanges': 'Uncommitted changes', 'review.baseBranch': 'Changes against a base branch',
    'review.commit': 'Specific commit', 'review.custom': 'Custom review', 'review.branch': 'Branch name', 'review.sha': 'Commit ID',
    'review.instructions': 'Review instructions', 'review.run': 'Start review', 'review.run.unarchive': 'Unarchive and review',
    'plan.exit': 'Exit Plan mode', 'plan.enter.unarchive': 'Unarchive and enter Plan mode', 'plan.exit.unarchive': 'Unarchive and exit Plan mode',
    'plan.changeFailed': 'Could not change mode',
    'goal.exit': 'Exit Goal input mode', 'goal.budget': 'Set budget', 'goal.optionalBudget': 'Token budget (optional)',
    'goal.replace': 'Replace goal', 'goal.confirmReplace': 'The text in the composer will replace the current goal.',
    'goal.resumeBudget': 'The goal is out of tokens. Use /goal to set a new budget.',
    'goal.resumeBlocked': 'Codex could not resume this goal. Check its current status.',
  },
}

function CommandOverlay({ controls, ...props }) {
  return controls && <>
    <CommandDialog {...props} {...controls} />
    <GoalReplacement {...props} session={controls.session} />
  </>
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
  installGoalBar(ctx, t)

  ctx.inject(['commandUi', 'sessions', 'conversation'], scope => {
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
        const focus = () => {
          if (sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView) scope.conversation.input.for(binding.ctx).focus()
        }
        controls.set(binding, { session, focus, commandRequest: createSnapshotStore(null), planAction: createPlanAction(binding.ctx, session) })
      }
      return controls.get(binding)
    }
    const rename = () => ctx.slots.entries(renameMenu).find(entry => entry.options.id === 'rename')?.inject().requestSessionRename
    const available = ({ sessionId }) => Boolean(sessions.binding(sessionId))
    const modeAvailable = ({ sessionId }) => {
      const state = sessions.binding(sessionId)?.session.getSnapshot()
      return Boolean(state && !commandUnavailable(state))
    }
    const commands = [
      { name: 'status', icon: IconInfoOutlineRegular },
      { name: 'goal', icon: IconGoalOutlineRegular, available: modeAvailable, async run({ sessionId }) {
        const { session, planAction, focus } = controlsFor(sessionId)
        const { planMode, archived } = session.getSnapshot()
        const change = planAction.getSnapshot()
        if (change?.pending) return
        if (change?.archivedMode) planAction.dismiss()
        if ((planMode === 'plan' || change?.mode === 'plan') && !archived && !await planAction.select('default', false)) return
        if (!session.goalDraft.getSnapshot()) session.goalDraft.set({ budget: '' })
        focus()
      } },
      { name: 'compact', icon: IconFlatListOutlineRegular },
      { name: 'review', icon: IconSearchOutlineRegular },
      { name: 'plan', icon: IconPlanOutlineRegular, available: modeAvailable, run({ sessionId }) {
        const { session, planAction, focus } = controlsFor(sessionId)
        const draft = session.goalDraft.getSnapshot()
        if (session.getSnapshot().planMode === 'plan' && draft) session.goalDraft.clear(draft)
        else planAction.request(session.getSnapshot().planMode === 'plan' ? 'default' : 'plan')
        focus()
      } },
      { name: 'ps', icon: IconCodeOutlineRegular },
      { name: 'export', icon: IconDownloadOutlineRegular },
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
    scope.inject(['contextMenus'], menu => {
      menu.effect(() => menu.contextMenus.register({
        id: 'codex.export', target: 'sessionHeader', order: 100,
        observe: () => [menu.locale],
        resolve: ({ sessionId }) => controlsFor(sessionId) ? [{
          id: 'export', label: t('export'),
          run: () => { controlsFor(sessionId)?.commandRequest.set({ command: 'export' }) },
        }] : [],
      }))
    })
    scope.slots.inject(overlay, () => scope.slots.register({
      name: overlay, id: 'codex-command-details', order: 30, locale,
      inject: sessionId => ({ controls: controlsFor(sessionId) }),
    }, CommandOverlay))
    scope.slots.inject(planSlot, () => scope.slots.register({
      name: planSlot, locale,
      inject: sessionId => ({ controls: controlsFor(sessionId) }),
    }, PlanChip))
    scope.slots.inject(goalSlot, () => scope.slots.register({
      name: goalSlot, id: 'codex-goal-mode', locale,
      inject: sessionId => ({ controls: controlsFor(sessionId) }),
    }, GoalChip))
  })
}
