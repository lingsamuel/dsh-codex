# 给 AI 助手的安装指南

把插件安装到独立的 DSH `codex` Profile，并用有效配置确认安装结果。用户要求启动时，再用浏览器核对本机 Codex 会话是否可见。

## 1. 检查目标环境

在目标用户的终端执行以下检查。

```sh
node --version
dsh --version
pnpm --version
codex app-server daemon version
```

- **Node.js** 需要 24.22.3 或更新的 24.x，或 26.13.1 及以上版本。
- **DSH 和 pnpm** 需要在当前终端可用。安装使用 DSH 0.2.3-alpha.2。
- **Codex** 需要已登录，运行插件时需要本机共享 App Server。插件使用 App Server 0.171.0 验证。已登录且 daemon 尚未运行时，可执行 `codex app-server daemon start`。

## 2. 取得插件包

优先使用用户提供的 `.tgz`，也可从 GitHub Actions 的 Build 工作流下载并解压 `dsh-chatgpt` artifact。只有源码时，在仓库根目录打包，使用 `artifacts/` 中本次生成的 `.tgz`。

```sh
npm ci
npm run package:plugin
```

## 3. 安装并验证配置

安装和启动使用同一个 DSH 可执行文件和同一个 `DSH_HOME`。

- **更新插件**时，沿用现有安装的目录和 `codex` Profile。
- **首次从源码启动方式迁移**时，使用新的持久目录。插件会从原有 Codex App Server 读取会话。

将示例路径替换为实际包的绝对路径。首次安装会创建 `codex` Profile。

```sh
dsh plugin --profile codex add /absolute/path/to/dsh-chatgpt-0.1.7.tgz
dsh --profile codex --dump-config
```

安装验收以 `--dump-config` 输出中出现 `dsh-chatgpt` Bundle 为准。

## 4. 按需启动并验证会话

用户要求运行时，执行以下命令。已有运行实例时，重启该实例以加载新版本。

```sh
dsh --profile codex --no-open
```

默认地址为 `127.0.0.1:3190`。端口已占用时用 `--port` 指定其他端口。用 DSH 打印的完整链接在本地浏览器打开，确认侧栏能显示 Codex 工作区和会话。链接包含访问令牌，汇报时给出验证结果和地址端口即可。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 有效配置缺少 `dsh-chatgpt` | 核对安装和验证命令所用的 DSH、`DSH_HOME` 和 `codex` Profile |
| 安装后页面仍是旧版本 | 核对当前运行的 `codex` 实例是否已重启 |
| 页面可以打开，会话无法读取 | 检查共享 App Server 状态，使用 `DSH_CHATGPT_SOCKET` 时核对其指向的端点 |
