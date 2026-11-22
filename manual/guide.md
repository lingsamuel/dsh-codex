# 启动与使用

需要 Node.js 24.9 或更新版本、可在当前 WSL 环境运行的 `dsh`，以及正在运行的 Codex App Server。首版使用 DSH 0.2.1-rc.2 和 Codex App Server 0.171.0 验证。

```sh
npm ci
npm run build
npm start -- --no-open
```

用浏览器打开 DSH 打印的完整启动链接。服务监听 `127.0.0.1:3190`，可通过 `--port` 指定另一个端口。启动链接包含本次运行的 DSH 访问令牌。

DSH 原生侧栏显示 Codex 的项目和工作目录。打开页面后，侧栏先显示缓存或已索引的项目，再从 Codex 自动补齐和刷新。同一个目录的大小写别名使用实际名称。浏览器默认打开一条近期的 Codex 会话。展开工作区可切换会话，从对话顶部可加载更早的轮次。

默认通过 `codex app-server daemon version` 查找当前环境中的共享服务。自定义 socket 可设置 `DSH_CHATGPT_SOCKET`，自定义 Codex 或 DSH 可执行文件可分别设置 `DSH_CHATGPT_CODEX_BIN` 和 `DSH_CHATGPT_DSH_BIN`。

目前提供 WSL 上未归档交互会话的只读浏览。打开对话后会实时跟随 Codex 写入的消息和工具记录。DSH 侧栏用转圈表示运行中，用黄点表示等待审批或回复，用绿点表示 Codex 标记为未读。网页打开会话时保留原生未读。标题栏补充连接和异常提示。尚未保存的逐字输出会在 Codex 写入后显示。本地文件附件显示原生引用。执行、插话、审批和回复继续使用原生 CLI。
