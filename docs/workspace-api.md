# Workspace API

后端现在提供 workspace 文件浏览、搜索、可审查 patch 和低风险 shell 预执行能力。它的目标是先让系统安全地“看项目”，再把写入和命令执行都放进明确的策略与审计边界。

## 安全边界

- workspace 必须先注册。
- 注册目录必须位于允许根目录之下。
- 默认允许根目录会向上寻找当前仓库根；生产环境建议显式设置 `WORKSPACE_ALLOWED_ROOTS`。
- 所有文件路径必须是 workspace 内的相对路径。
- 服务端会用 `realpath` 检查符号链接和 `../` 逃逸。
- 默认跳过 `.git`、`node_modules`、`dist`、`.logs`、`.vite`。
- `.env`、`.env.local` 等敏感配置文件不会出现在树/搜索中，也不能直接读取。
- 单文件读取限制为 256 KB；二进制文件不会作为文本返回。
- 搜索会限制文件大小、扫描数量和返回结果数量。
- shell API 不使用 shell 解释器，不支持管道、重定向或命令拼接。
- shell API 只在 Linux 后端启用；非 Linux 开发环境会返回 `shell_runner_linux_required`。
- shell API 只允许少量只读命令；命令必须先通过策略分类，且命中高风险/需确认策略会被拒绝。
- shell API 不继承服务进程的 `PATH` 查找命令，只从 Linux 系统可信路径解析 `pwd` 和 `ls`。
- shell API 会限制 cwd、超时和输出大小，并对输出做基础脱敏。

`WORKSPACE_ALLOWED_ROOTS` 使用当前系统的 path delimiter 分隔：

- Linux/macOS：`:`
- Windows：`;`

## 接口

### `GET /api/workspaces`

返回允许根目录和已注册 workspace。

### `POST /api/workspaces`

注册 workspace。

```json
{
  "root": "C:\\project\\newcode",
  "name": "web-claude-code"
}
```

### `GET /api/workspaces/:workspaceId/tree?path=.&depth=3`

返回文件树。`path` 必须是相对路径，`depth` 范围为 `0..6`。

### `GET /api/workspaces/:workspaceId/files?path=README.md`

读取文本文件。超大文件、二进制文件、workspace 外路径会被拒绝。

### `GET /api/workspaces/:workspaceId/search?query=workspace&limit=50`

搜索 workspace 文本文件。搜索是简单大小写不敏感子串匹配。

### `POST /api/workspaces/:workspaceId/patches/preview`

预览对单个文本文件的修改，返回 base hash 和截断后的 diff，不写入文件。

### `POST /api/workspaces/:workspaceId/patches/apply`

在 base hash 未变化时应用已经预览过的修改。超大文件、二进制文件和 hash 冲突会被拒绝。

### `POST /api/workspaces/:workspaceId/shell`

在 workspace 内运行 allowlist 中的低风险只读命令。

```json
{
  "command": "pwd",
  "cwd": ".",
  "timeoutMs": 5000
}
```

当前只允许手动 API 调用，不会被模型自动触发。高风险命令、依赖安装、网络命令、Git 命令、`ls` 路径参数和任何带管道/重定向/命令拼接的输入都会被拒绝。

### `GET /api/workspaces/:workspaceId/audit`

返回该 workspace 的基础审计事件。

## 错误结构

```json
{
  "error": {
    "code": "path_not_allowed",
    "message": "Resolved path is outside the workspace."
  }
}
```

后续接入前端时，UI 应优先依赖 `error.code` 做本地化展示。
