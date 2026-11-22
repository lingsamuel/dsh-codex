# 启动与使用

需要 Node.js 24.9 或更新版本、可在当前 WSL 环境运行的 `dsh`，以及正在运行的 Codex App Server。首版使用 DSH 0.2.1-rc.2 和 Codex App Server 0.171.0 验证。

```sh
npm ci
npm run build
npm start -- --no-open
```

用浏览器打开 DSH 打印的完整启动链接。服务监听 `127.0.0.1:3190`，可通过 `--port` 指定另一个端口。启动链接包含本次运行的 DSH 访问令牌。

侧栏直接显示 Codex 的原生项目和工作目录。选择会话可浏览消息和工具记录。列表底部可以加载更多会话，对话顶部可以加载更早的轮次。

默认通过 `codex app-server daemon version` 查找当前环境中的共享服务。自定义 socket 可设置 `DSH_CHATGPT_SOCKET`，自定义 Codex 或 DSH 可执行文件可分别设置 `DSH_CHATGPT_CODEX_BIN` 和 `DSH_CHATGPT_DSH_BIN`。

首版提供 WSL 上未归档交互会话的只读浏览。本地文件附件显示原生引用。执行、插话和审批继续使用原生 CLI。
