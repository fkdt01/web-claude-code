# 自动推进循环

## 目标

让 Web Claude Code 的开发能在自动化唤醒后稳定前进：每轮只推进一个清晰的垂直切片，同时用两个固定审查角色把控质量和架构一致性。

## 固定角色

### 主执行者

负责选择本轮任务、实现代码、运行验证、提交变更和汇报结果。主执行者可以在任务可并行时启动额外 worker，但必须保证写入范围互不冲突。

### 代码质量代理

每轮开始和结束都可启用，关注：

- TypeScript 严格模式是否保持通过。
- 模块边界是否清楚，是否出现不必要耦合。
- API 错误处理、输入校验和可测试性。
- Linux 部署路径是否被破坏。
- 是否引入未审查依赖、敏感信息或危险默认行为。

### 架构一致性代理

每轮开始和结束都可启用，关注：

- 是否仍围绕 Web 版 Claude Code 工作台推进。
- 是否符合多模型 Provider、工具权限、审计、Linux 后端、安全沙箱的大框架。
- 是否保持中文优先和 ChatGPT 风格会话体验。
- 是否偏离 `docs/architecture.md` 与 `docs/implementation-plan.md` 的路线图。

## 每轮任务循环

1. 读取当前状态
   - 查看 `git status`、最近提交和未完成文档。
   - 读取 `README.md`、`docs/architecture.md`、`docs/implementation-plan.md`、本文件。

2. 选择一个任务
   - 优先选择路线图中最靠前、可以独立验证的任务。
   - 默认顺序：workspace 文件树/read/search → diff review/apply patch → SSE 流式输出 → Linux sandbox shell → 真实模型成本和路由。

3. 并行审查
   - 启动代码质量代理，要求给出质量门禁和风险。
   - 启动架构一致性代理，要求核对本轮任务是否符合整体框架。
   - 如果实现工作可拆分，再启动 worker，并明确互不重叠的文件范围。

4. 实现最小可用切片
   - 只改本轮任务需要的文件。
   - 优先沿用现有 `apps/server`、`apps/web`、`packages/core` 三层结构。
   - 不绕开工具权限、审计和安全策略。

5. 验证
   - 必跑：`npm run typecheck`。
   - 前端或构建相关改动必跑：`npm run build`。
   - API 改动要增加或执行 smoke check。
   - Linux 部署相关改动要检查 Dockerfile/systemd 文档一致性。

6. 收敛
   - 对照两个代理意见修正关键问题。
   - 更新相关文档。
   - 提交并推送到 `main`。
   - 汇报本轮完成、验证结果、遗留风险和下一轮建议。

## 质量门禁

每轮结束前必须满足：

- 工作区没有意外未提交变更。
- `npm run typecheck` 通过。
- 若触及 Web 或打包配置，`npm run build` 通过。
- 新增 shell、文件写入、网络访问能力时必须有策略和审计。
- 不提交 `.env`、密钥、临时日志、构建产物或 `node_modules`。
- 不复制未授权第三方源码。

## 停机条件

遇到以下情况应停止自动推进并向用户汇报：

- 需要 GitHub、模型 Provider、服务器或密钥授权。
- 需要破坏性命令或系统级权限。
- 任务边界不清，继续实现会造成明显架构偏移。
- 类型检查或构建失败且无法在本轮内安全修复。
- 发现可能泄露密钥或越权访问的风险。

## 下一阶段默认任务池

1. 实现 workspace 注册、文件树、read/search API。
2. 在 Web 侧加入文件浏览和文件预览。
3. 把 read/search 工具调用写入审计。
4. 增加 patch 数据结构和 diff review UI。
5. 增加 SSE 事件流，让模型输出和工具状态实时显示。
6. 增加容器化 runner 方案，替换本地 shell 假实现。
7. 增加真实 Provider 的成本统计和模型路由策略。
