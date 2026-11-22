# Codex 权限切换与插话提示

## 交互

- DSH 网页沿用输入框下方的权限菜单。普通会话选择预设即可更新会话设置，无需发送对话消息。归档会话延续现有预设草稿流程，在取消归档并发送或继续队列时应用。
- 当前轮正在运行、输入框有正文，且已确认的下轮设置与本轮权限有差异时，权限菜单旁显示「新权限从下一轮生效，插话沿用本轮权限」。悬停可查看 Codex 为活动轮次记录的权限预设、沙箱和审批策略。从已有队列启动的下一轮也使用更新后的预设。

## 数据来源

会话设置沿用现有 Codex 权限接口。Codex 将沙箱和审批策略的会话更新用于后续轮次，插话给活动轮次追加输入。 [会话设置协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) · [插话协议](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)

复用 DSH 现有的 Codex rollout 增量读取和实时通道，将原生 `turn_context` 中的权限摘要按轮次 ID 提供给当前会话。只有摘要与活动轮次匹配时才展示。界面显示轮次记录中的基础权限，具体工具请求的临时授权继续由审批界面报告。 [Codex 轮次记录测试](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/persisted_resume_settings_tests.rs)

## 验收

- 点击输入框权限按钮可选择预设，聊天与待发队列没有新增消息。
- 一轮以工作区权限运行时切为只读，输入正文后，菜单显示已选的只读预设，提示说明插话沿用本轮权限，悬停显示本轮工作区权限。输入框的文本和权限均来自当前会话。
- 输入框为空或只有空白、两轮权限一致、差异尚待确认或轮次结束时，收起插话权限提示。
