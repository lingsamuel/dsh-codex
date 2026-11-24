# dsh-schedule-for-codex

基于官方 `@deepseek-ai/dsh-schedule` 和 `@deepseek-ai/dsh-client-ui-schedule` 的构建时 fork。版本由仓库依赖清单锁定，上游 MIT 许可保留在构建产物中。

- Host 补丁为 Codex 使用独立的任务域，并将会话投递替换为可确认的 Codex 原生队列投递。
- 客户端补丁复用自动化任务页面，接入 Codex 的管理入口和已有会话选择。

更新上游依赖时，在新源码上复核补丁，并验证等待投递、回执恢复和两种 Web 模式的任务隔离。
