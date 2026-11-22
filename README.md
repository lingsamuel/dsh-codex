# DSH ChatGPT

DSH ChatGPT 在独立的 DeepSeek Harness `codex` Profile 中接入本机 Codex。你可以通过 DSH 的原生工作区和聊天界面浏览项目、查看历史，或接着处理 CLI 中的任务。

## 核心功能

- 浏览项目、会话、归档和子智能体，搜索历史并实时查看消息与工具记录。
- 在原会话发送消息、转发审批与问答、查看和管理队列与后台任务。
- 使用 DSH 原生界面预览工作区文件、查看差异、粘贴图片和引用路径。
- 在网页选择 Codex 技能、管理插件与 MCP、选择 Git 工作树，并导出完整会话 Markdown。

## 运行边界

Codex 持有会话历史、模型、权限和执行状态。插件通过本机共享 Codex App Server 读取这些状态，并把网页上的操作交给 Codex 执行。运行时需要既有的 Codex 登录与共享服务，网页默认只监听本机回环地址。

[安装与使用](manual/guide.md) · [给 AI 助手的安装指南](manual/ai-install.md) · [架构](https://github.com/lingsamuel/dsh-codex/blob/master/docs/architecture.md)
