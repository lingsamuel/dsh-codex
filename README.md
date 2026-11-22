# DSH ChatGPT

DSH ChatGPT 是本机 Codex 的展示和转发层。它在独立的 DeepSeek Harness `codex` Profile 中，用 DSH 的原生工作区、侧栏和聊天界面呈现 Codex 会话。

如果你已经在使用 Codex CLI，希望在浏览器里快速切换项目和长对话，或接着处理 CLI 中的任务，可以用它打开同一批会话。

## 核心功能

- 浏览项目、会话、归档和子智能体，搜索历史并实时查看消息与工具记录。
- 在原会话发送消息、转发审批与问答、查看和管理队列与后台任务。
- 使用 DSH 原生界面预览工作区文件、查看差异、粘贴图片和引用路径。

## 运行边界

Codex 持有会话历史、模型、权限和执行状态。插件通过本机共享 Codex App Server 读取这些状态，并把网页上的操作交给 Codex 执行。运行时需要既有的 Codex 登录与共享服务，网页默认只监听本机回环地址。

[安装与使用](manual/guide.md) · [给 AI 助手的安装指南](manual/ai-install.md) · [架构](https://github.com/lingsamuel/dsh-codex/blob/master/docs/architecture.md)
