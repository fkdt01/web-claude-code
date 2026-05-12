# 完整实施方案

## 一句话定位

Web Claude Code 是一个浏览器里的多模型编程代理工作台：用户提出任务，系统组织多个模型讨论、读取项目上下文、生成可审查修改、执行受控命令，并把每一步记录到审计日志。

## MVP 目标

第一版先做“可信的半自动编程助手”，不要直接追求全自动：

- 中文 Web 工作台，布局参考 ChatGPT 的会话体验。
- 支持 mock、Anthropic、OpenAI-compatible、OpenRouter、Gemini。
- 支持单模型、竞速、委员会、专家组四种编排。
- 支持工具规格、权限声明和 shell 策略分类。
- 支持 Linux 后端部署。
- 支持运行记录、模型响应、token 用量和审计事件。

## 核心模块

### 1. Model Gateway

统一所有模型接口。业务层只使用内部协议，不直接写 Anthropic/OpenAI/Gemini 的差异逻辑。

每个 Provider Adapter 负责：

- 模型列表和可用状态。
- 消息格式转换。
- tool call/JSON/vision/streaming 能力声明。
- usage 和错误格式归一化。
- 后续成本估算。

### 2. Agent Orchestrator

负责任务编排，而不是直接执行危险操作。

- `single`：低成本直接回答。
- `race`：低延迟并行响应。
- `committee`：多模型独立讨论后汇总。
- `specialist`：planner/coder/reviewer/generalist 分工。

原则：多个模型可以讨论，但文件写入只交给一个执行器，避免并发修改冲突。

### 3. Tool Runtime

工具必须声明权限，再进入策略层：

- `read_file`：工作区只读。
- `search_workspace`：工作区搜索。
- `propose_patch`：生成 patch，不直接应用。
- `run_shell`：隔离环境执行命令。

后续工具包括 Git、测试运行、依赖扫描、MCP、浏览器自动化和部署检查。

### 4. Policy Engine

所有高风险行为先分类：

- 自动允许：工作区内 read/search、无副作用检查。
- 需要确认：安装依赖、Git 写操作、联网命令、测试命令。
- 默认拒绝：`curl | sh`、越权路径、读取密钥、Docker socket、破坏性删除。

策略结果必须写入审计日志。

### 5. Workspace Sandbox

生产环境必须把执行环境和 Web 服务隔开：

- 每个项目/会话独立容器或 microVM。
- 只挂载目标 workspace。
- 限制 CPU、内存、磁盘、网络、进程数和运行时长。
- shell 输出截断并脱敏。
- 结束后销毁或生成快照。

## 数据模型建议

后续持久化可以从这些表开始：

- `users`：用户和认证。
- `workspaces`：项目、仓库地址、默认分支、运行环境。
- `sessions`：会话和任务状态。
- `runs`：一次编排任务。
- `model_calls`：Provider、model、prompt tokens、output tokens、费用、错误。
- `tool_calls`：工具名、参数摘要、策略决策、结果摘要。
- `patches`：文件路径、diff、审批状态、应用状态。
- `audit_events`：不可变审计日志。
- `secrets`：密钥引用，不存明文到普通数据库。

## Linux 部署建议

第一阶段：

- 后端：Node 24 + Fastify，通过 systemd 或 Docker 运行。
- 前端：Vite build 后交给 Nginx/Caddy。
- 反向代理：TLS、压缩、请求体限制、CORS 白名单。
- 日志：stdout 进 journald 或容器日志系统。

第二阶段：

- API Server 和 Sandbox Runner 拆成两个服务。
- Runner 运行在独立机器或容器集群。
- Provider 密钥进入 Vault/KMS。
- 审计日志进入 PostgreSQL + 对象存储。

## 里程碑

### M1：可用原型

- 当前仓库骨架。
- mock 多模型编排。
- 中文 ChatGPT 风格工作台。
- Linux 部署文档。

### M2：真实项目上下文

- 导入 Git 项目。
- 文件树、全文搜索、代码片段读取。
- 任务上下文构建和 token 预算裁剪。

### M3：可审查编辑

- 模型生成 patch。
- Web diff viewer。
- 单文件/多文件审批。
- 应用 patch 后自动刷新文件状态。

### M4：安全命令执行

- 容器化 workspace runner。
- 命令审批、超时、输出截断。
- 测试命令模板和风险分类。

### M5：企业化

- RBAC/SSO。
- 组织策略和预算。
- 私有模型网关。
- MCP 插件治理。
- DLP、secret scanning、依赖安全扫描。

## 主要风险

- 安全风险：模型诱导工具越权、shell 失控、密钥泄露。
- 成本风险：多模型并行和长上下文容易失控。
- 稳定性风险：长任务、流式输出、沙箱生命周期复杂。
- 产品风险：全自动修改代码容易让用户失去控制感。
- 合规风险：不要复制或依赖未授权源码。

## 当前下一步

最推荐先做 M2 和 M3：

1. 增加 workspace import。
2. 增加文件树和 search/read 工具。
3. 增加 patch 数据结构和 diff review UI。
4. 用 mock provider 跑完整编辑闭环。
5. 再接真实模型和容器化 shell。
