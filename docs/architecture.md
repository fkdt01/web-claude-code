# Web Claude Code 架构方案

## 产品目标

做一个 Web 版编程代理：用户在浏览器里描述任务，系统可以读取项目上下文、调用多个模型讨论方案、生成可审查 patch、执行受控命令并留下完整审计记录。

## 系统分层

1. 浏览器工作台
   - 会话导航、任务输入、模型选择、编排模式。
   - 对话流、计划状态、diff 审查、终端输出、审计面板。

2. API Server
   - 登录/session 边界。
   - Run 生命周期和事件流。
   - Provider Registry 和 Model Gateway。
   - Policy Engine、Tool Dispatch 和 Audit Log。

3. Agent Orchestrator
   - 根据用户最新指令、工作区索引、历史摘要和工具结果构建上下文。
   - 支持 `single`、`race`、`committee`、`specialist`。
   - 多模型可以讨论，但真实文件写入只交给一个执行器。

4. Tool Runtime
   - 工具声明 JSON schema 和权限需求。
   - 每次工具调用先过策略层。
   - 文件编辑先生成 patch，用户或策略批准后再应用。
   - shell 命令必须有 cwd、超时、输出截断、进程限制和审计。

5. Workspace Sandbox
   - 每个用户、项目、会话使用独立运行环境。
   - 只挂载目标工作区，不暴露宿主机 home。
   - 限制 CPU、内存、磁盘、进程数、运行时长和网络访问。
   - 会话结束后销毁、快照或归档必要产物。

## Provider 策略

内部统一使用中立协议，Provider 只负责转换：

- Anthropic Messages API。
- OpenAI-compatible Chat Completions。
- OpenRouter。
- Gemini generateContent。
- 本地模型的 OpenAI-compatible 服务。

每个模型声明 context window、tool call、streaming、JSON mode、vision 和价格信息。业务层只看能力，不硬编码厂商。

## 安全模型

默认只读、可观察、可追溯。

- read/search 可在工作区内自动执行。
- edit 生成 diff，不直接落盘。
- test/build/package-manager 命令默认需要批准。
- 删除大量文件、访问上级目录、读取 `.env`、访问 Docker socket、`curl | sh` 等默认拒绝。
- 密钥保存在后端 vault/secret manager，只按工具或 Provider 短期下发。
- 日志做结构化记录，并进行敏感信息脱敏。

## MVP 范围

- 中文 Web 工作台。
- mock provider + Anthropic/OpenAI-compatible/OpenRouter/Gemini 适配点。
- `single`、`race`、`committee`、`specialist` 四种编排。
- 工具与策略类型系统。
- 运行审计事件。
- Linux 后端部署文档和 Dockerfile。

## 路线图

1. 增加 SSE/WebSocket token 流和工具状态流。
2. 增加 Git 项目导入、文件树和索引。
3. 实现 read/search 工具，并做路径限制。
4. 实现 patch 生成、diff 审查和受控 apply。
5. 实现容器化 shell 执行。
6. 增加持久化 run、会话、成本统计。
7. 接入 MCP 工具。
8. 增加团队权限、RBAC、组织预算和企业策略。
