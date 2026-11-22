# Codex 权限命令与运行中权限展示

## 交互

- 在 DSH 网页命令菜单加入 `/permissions`，打开当前会话的权限选择界面。命令和输入框下方的权限按钮共用预设目录、选择确认和提交流程。选择预设即可更新会话设置，无需发送对话消息。
- 会话运行时，权限界面同时显示「本轮权限」和「下轮权限」。本轮展示 Codex 为该轮记录的权限预设、沙箱和审批策略。下轮展示会话当前选择的预设，可在运行时切换。例如本轮显示「工作区内修改」，选中「仅可查看」后，下轮显示「仅可查看」。从已有队列启动的下一轮也使用更新后的会话设置。
- 本轮记录尚未落盘或无法读取时，显示「本轮权限未确认」。轮次结束后收起本轮信息。归档会话延续现有预设草稿流程，在取消归档并发送或继续队列时应用。

## 数据来源

会话设置沿用现有 Codex 权限接口。Codex 将沙箱和审批策略的会话更新用于后续轮次，插话给活动轮次追加输入。 [会话设置协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) · [插话协议](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)

复用 DSH 现有的 Codex rollout 增量读取和实时通道，将原生 `turn_context` 中的权限摘要按轮次 ID 提供给当前会话。只有摘要与活动轮次匹配时才展示。界面显示轮次记录中的基础权限，具体工具请求的临时授权继续由审批界面报告。 [Codex 轮次记录测试](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/persisted_resume_settings_tests.rs)

## 验收

- 输入 `/permissions` 或点击输入框权限按钮均可选择预设，确认弹窗和错误提示一致，聊天与待发队列没有新增消息。
- 一轮以工作区权限运行时切为只读，界面同时显示本轮工作区权限和下一轮只读。切到另一会话再返回，或重连浏览器后，仍依据活动轮次的记录显示。
- 本轮记录缺失时显示未确认。轮次结束或切换以后，旧轮次的权限摘要不会被误显示为新一轮的权限。
