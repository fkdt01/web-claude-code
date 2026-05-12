# 参考项目拆解

## 边界

`paoloanzn/free-code` 已归档，并在 README 中说明原始 Claude Code 源码属于 Anthropic。因此这里不复制它的源码、提示词、内部命令或具体实现，只从公开说明里提炼“产品能力分层”和“模块边界”。

## 可观察形态

从公开 README、安装脚本和包信息看，它是一个终端原生的 TypeScript/Bun 编程代理。公开层面能看到这些模块：

- CLI 入口和命令注册。
- 面向 LLM 的查询/工具循环。
- read、edit、shell、search、agent 等工具注册。
- Anthropic、OpenAI/Codex、Bedrock、Vertex 等 Provider 层。
- 基于 React/Ink 的终端 UI。
- 状态、历史、设置、OAuth、服务和工具函数。
- MCP、skills、plugins、IDE Bridge、后台任务等扩展点。
- 围绕计划、验证、记忆、token 预算、命令分类的功能开关。

## Web 化映射

Web 版不应该只是终端复制品，而应变成项目工作台：

- 终端 UI 变成浏览器里的对话、文件、diff、终端、审计面板。
- 查询引擎变成 Agent Orchestrator，持续输出结构化事件。
- Provider 客户端变成 Model Gateway，通过统一协议屏蔽厂商差异。
- 工具注册变成 Tool Runtime，所有调用先过权限和策略。
- 本地状态变成服务端 workspace 状态和浏览器 UI 状态。
- CLI 命令变成命令面板、按钮和审批弹窗。
- feature flag 变成项目/组织策略，而不是绕开安全边界。

## 值得重建的能力

- 多 Provider 和模型能力声明。
- 规划、编码、评审等多代理协作。
- token 和成本预算。
- read/search/edit/shell 工具，以及审批和审计。
- MCP/plugin 扩展面。
- 会话历史、上下文压缩和项目记忆。
- 后台任务，但必须等沙箱和审计成熟后再开放。

## 不应该继承的方向

- 移除安全护栏。
- 无审批执行任意 shell。
- 把密钥放进提示词、日志或浏览器长期存储。
- 基于未授权源码继续开发。
- 把“能编译”误认为“运行时安全”。
