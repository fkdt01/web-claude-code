# Web Claude Code

一个原创的 Web 版 Claude Code 风格编程代理框架，目标是把终端 AI Coding Agent 的核心能力搬到浏览器工作台里：多模型编排、可审查代码修改、命令审批、工具权限、审计日志和 Linux 后端部署。

本项目只把 `paoloanzn/free-code` 当作公开产品形态参考，不复制其源码、提示词或隐藏实现。

## 当前包含

- `apps/web`：React 中文工作台，布局参考 ChatGPT 的左侧栏 + 中央对话 + 底部输入框，并已接入只读工作区文件树和文件预览。
- `apps/server`：Fastify API，包含 Provider Registry、模型适配器、编排器和策略接口。
- `packages/core`：共享协议、模型事件、工具规格和安全策略类型。
- `docs/project-breakdown.md`：对参考项目的模块拆解和 Web 化映射。
- `docs/architecture.md`：完整产品架构、MVP 范围和路线图。
- `docs/implementation-plan.md`：分阶段实施方案和风险清单。
- `docs/automation-loop.md`：自动推进循环、代理职责和质量门禁。
- `docs/workspace-api.md`：后端只读 workspace API 和路径安全边界。
- `docs/linux-deploy.md`：Docker 与 systemd 部署说明。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:5173`。后端默认运行在 `http://localhost:8787`。

首次运行不需要模型密钥，系统会启用 mock provider。要接入真实模型，复制 `.env.example` 并配置对应密钥。

## 支持的编排模式

- `single`：单模型直接回答。
- `race`：多个模型并行，先返回可用答案的模型胜出。
- `committee`：多个模型独立输出，再汇总为一个结论。
- `specialist`：按规划、编码、评审等职责组织多模型输出。

## 安全基线

- 工具先声明权限，再进入策略层。
- 写文件应先生成可审查 patch，不直接落盘。
- shell 命令按风险分类，危险命令默认拒绝，高风险命令进入审批。
- 生产环境应为每个工作区分配独立容器或 microVM。
- 密钥只保存在后端，不进入普通提示词或浏览器长期存储。

## Linux 部署

```bash
docker build -f apps/server/Dockerfile -t web-claude-code-server .
docker run --rm -p 8787:8787 --env-file .env web-claude-code-server
```

更多说明见 [docs/linux-deploy.md](docs/linux-deploy.md)。
