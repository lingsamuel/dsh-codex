# WSL 历史浏览实施计划

**目标** 在独立的 DSH Profile 中打开并浏览现有 Codex 会话。

**技术栈** Node.js、Codex App Server JSON-RPC、DSH 浏览器插件、React。

1. 先用真实 Unix WebSocket 测试服务器验证握手、分页、错误和连接关闭。实现面向现有 daemon 的只读 API。
2. 装配独立 Profile，使用 DSH 公开的 Fetch 路由和客户端 Slot 注册。复用 Markdown 和代码渲染，按原生项目或工作目录呈现会话。
3. 构建插件，验证真实 daemon 的历史分页和 DSH 浏览器挂载。记录运行方式与当前验证范围。
