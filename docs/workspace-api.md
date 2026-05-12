# Workspace API

后端现在提供第一版只读 workspace 能力。它的目标是先让系统安全地“看项目”，还不做 patch 应用和 shell 执行。

## 安全边界

- workspace 必须先注册。
- 注册目录必须位于允许根目录之下。
- 默认允许根目录会向上寻找当前仓库根；生产环境建议显式设置 `WORKSPACE_ALLOWED_ROOTS`。
- 所有文件路径必须是 workspace 内的相对路径。
- 服务端会用 `realpath` 检查符号链接和 `../` 逃逸。
- 默认跳过 `.git`、`node_modules`、`dist`、`.logs`、`.vite`。
- 单文件读取限制为 256 KB；二进制文件不会作为文本返回。
- 搜索会限制文件大小、扫描数量和返回结果数量。

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
