# 给 AI 助手的安装指南

一般用户使用 `dsh-for-codex-<版本>.tgz`，给已有的 DSH Web 加入 Codex。用户需要单独启动极简 DSH Web 服务时，使用 `dsh-for-codex-min-<版本>.tgz`。用户要求启动时，再用浏览器核对本机 Codex 会话是否可见。

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

在用户提供的 `.tgz` 或 GitHub Actions 的 `dsh-for-codex` 构建产物中选包。只有源码时，在仓库根目录打包，从 `artifacts/` 取得生成的 `.tgz`。

```sh
npm ci
npm run package:plugin
```

两种包的 npm 名称都是 `dsh-for-codex`，各自都包含相同的代码和两份 YAML。以归档中 `package/package.json` 的 `dsh.bundle.patch` 为准。文件名和加载行为的对应关系见 [选择插件包](guide.md#选择插件包)。

## 3. 安装并验证配置

安装和启动使用同一个 DSH 可执行文件、同一个 `DSH_HOME` 和同一个 `--profile` 名称。更新时沿用原来的安装位置。首次从源码启动方式迁移时，选择一个新的持久安装位置。会话继续从原有 Codex App Server 读取。

### 给已有的 DSH Web 加入 Codex

使用 `dsh-for-codex-<版本>.tgz`。将 `web` 替换为当前 Web 实例实际使用的 Profile 名称，将包路径替换为实际绝对路径。

```sh
dsh plugin --profile web add '/absolute/path/to/dsh-for-codex-<版本>.tgz'
dsh --profile web --dump-config
```

核对 `--dump-config` 中的 `dsh-for-codex` 配置包含 `sharedWeb: true`。用原本的地址打开该实例，并切换到 Codex 模式进行验证。

### 单独启动极简 DSH Web 服务

使用带 `-min` 的包，示例沿用 `codex` 作为 Profile 名称。DSH 会在安装时创建尚不存在的 Profile。启动后可通过网页侧栏的「插件 → 添加插件」管理 DSH 插件。「设置 → Codex 插件」管理 Codex 插件。

```sh
dsh plugin --profile codex add '/absolute/path/to/dsh-for-codex-min-<版本>.tgz'
dsh --profile codex --dump-config
```

核对 `--dump-config` 中的 `dsh-for-codex` 和 `webserver` 条目。

## 4. 按需启动并验证会话

更新已有实例后，按原方式重启该实例以加载新版本。单独启动网页时，使用安装时选的名称。

```sh
dsh --profile codex --no-open
```

单独启动的默认地址为 `127.0.0.1:3190`，可用 `--port` 指定其他端口。用 DSH 打印的完整链接在本地浏览器打开，确认侧栏能显示 Codex 工作区和会话。链接包含访问令牌，汇报时给出验证结果和地址端口即可。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 有效配置缺少 `dsh-for-codex` | 核对安装和验证时使用的 DSH、`DSH_HOME` 和 `--profile` 值 |
| 安装后的行为与所选包不符 | 核对归档的 `dsh.bundle.patch` 和当前运行的 Profile，确认该实例已重新加载插件 |
| 页面可以打开，会话无法读取 | 检查共享 App Server 状态，使用 `DSH_CODEX_SOCKET` 时核对其指向的端点 |
