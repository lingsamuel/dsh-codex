# DSH ChatGPT 首版设计

DSH ChatGPT 运行在独立的 DSH Profile 中。DSH 提供网页启动、访问控制、插件装载、AppFrame、主题和 React 渲染。Codex 的工作区侧栏和对话视图通过公开插槽挂载，并使用 DSH 的正文、工具折叠和图标组件。

当前阶段验证 WSL 中的只读浏览。Host 连接已经运行的 Codex App Server，通过 `project/list`、`thread/list` 和 `thread/turns/list` 读取原生记录。已登记的项目使用原生项目 ID，其余线程按 `cwd` 展示。会话列表分页沿用 Codex 对旧历史的索引补齐行为。打开一条历史会话只读取轮次，按原始 ID 和时间显示。

浏览器通过 DSH 的同源 API 访问 Host，继续使用 DSH 默认的访问令牌和 Cookie。独立 Profile 使用项目本地目录，与日常 DSH 服务并行运行。项目和聊天历史由 Codex 持有。页面只在内存中保留已载入的分页数据。

DSH 的根视图要求安装可选 Session scope。插件提供空绑定，并将当前选中的原生线程标题投影给 AppFrame。布局与主题服务只管理界面。

会话列表按原生线程 ID 合并同一页和跨页记录，保留服务端的返回顺序。文件变更在浏览器中转换为 DSH DiffBlock 的显示输入，Codex 历史继续以原生格式读取。

后续交互接入直接沿用 Codex App Server 的发送、插话、停止和服务端请求。Windows 原生接入复用同一协议，前提是目标 Codex 实例提供共享端点。
