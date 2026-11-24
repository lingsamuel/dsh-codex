# dsh-schedule-for-codex

本目录是仓库内维护的源码 fork，由仓库的构建脚本直接编译。上游基线来自 DeepSeek Harness 的 npm 发行包，MIT 许可随源码和构建产物保留。

| 本地目录 | 上游包 | 版本 | 发行包内路径 |
| --- | --- | --- | --- |
| `host/` | `@deepseek-ai/dsh-schedule` | `0.2.3-alpha.2` | `package/src/` |
| `client/` | `@deepseek-ai/dsh-client-ui-schedule` | `0.2.3-alpha.2` | `package/src/client/` |

客户端的 CSS 模块类型声明来自同一发行包的 `package/src/css-modules.d.ts`。

Host 使用独立的任务域，通过 Codex 原生队列投递并确认消息。客户端沿用上游界面，接入 Codex 的管理入口和已有会话选择。类型由本 fork 的 Host 源码提供。Host 的任务存储 schema 使用上游基线的 Zod 版本，版本由根项目的开发依赖锁定。

## 更新上游

1. 在项目的临时目录下载表中记录的旧版本和计划采用的新版本，解包后按表定位源码。
2. 先用 `git diff --no-index` 对比两版上游源码，确定要合入的改动。修改过的文件可用 `git merge-file`，依次指定本地文件、旧上游文件和新上游文件，对照解决冲突。
3. 更新上游版本记录并同步受影响的构建依赖。运行仓库的构建和测试，验证到期投递、回执恢复和两种 Web 模式的任务隔离。
