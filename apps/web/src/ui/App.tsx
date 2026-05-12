import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Code2,
  FileCode2,
  KeyRound,
  Layers3,
  MessageSquarePlus,
  PanelLeft,
  Play,
  SendHorizonal,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  TriangleAlert,
  XCircle
} from "lucide-react";
import type { ModelDescriptor, OrchestrationMode, RunRequest } from "@webcode/core";
import { modelKey } from "@webcode/core";
import { createRun, loadBootstrap } from "./api";
import type { BootstrapPayload, ProviderPayload, UiRunState } from "./types";

const DEFAULT_PROMPT =
  "帮我设计一个 Web 版 Claude Code：支持多模型、可审查文件编辑、命令审批、审计日志，并优先考虑 Linux 后端部署。";

const modeCopy: Record<OrchestrationMode, { title: string; body: string }> = {
  single: {
    title: "单模型",
    body: "一个主模型直接回答"
  },
  race: {
    title: "竞速",
    body: "多个模型并行，先到先用"
  },
  committee: {
    title: "委员会",
    body: "多模型独立讨论后汇总"
  },
  specialist: {
    title: "专家组",
    body: "规划、编码、评审分工"
  }
};

function flattenModels(providers: ProviderPayload[]) {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerName: provider.displayName,
      key: modelKey(model),
      model
    }))
  );
}

function ModelStatus({ available }: { available: boolean }) {
  return (
    <span className={available ? "model-status ready" : "model-status missing"}>
      {available ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {available ? "可用" : "缺少密钥"}
    </span>
  );
}

function ModelRow({
  providerName,
  model,
  checked,
  onToggle
}: {
  providerName: string;
  model: ModelDescriptor;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={`model-row ${checked ? "selected" : ""} ${model.available ? "" : "muted"}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={!model.available} />
      <span className="model-copy">
        <strong>{model.label}</strong>
        <small>
          {providerName} · {model.role} · {model.capabilities.contextWindow.toLocaleString()} ctx
        </small>
      </span>
      <ModelStatus available={model.available} />
    </label>
  );
}

function ModeButton({
  mode,
  current,
  onClick
}: {
  mode: OrchestrationMode;
  current: OrchestrationMode;
  onClick: () => void;
}) {
  return (
    <button className={`mode-button ${mode === current ? "active" : ""}`} type="button" onClick={onClick}>
      <strong>{modeCopy[mode].title}</strong>
      <span>{modeCopy[mode].body}</span>
    </button>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [mode, setMode] = useState<OrchestrationMode>("committee");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [runState, setRunState] = useState<UiRunState>({ status: "idle" });
  const [showInspector, setShowInspector] = useState(true);

  useEffect(() => {
    loadBootstrap()
      .then((payload) => {
        setBootstrap(payload);
        setSelectedModels(
          flattenModels(payload.providers)
            .filter((entry) => entry.model.provider === "mock")
            .map((entry) => entry.key)
        );
      })
      .catch((error) => {
        setRunState({
          status: "error",
          error: error instanceof Error ? error.message : "加载模型配置失败"
        });
      });
  }, []);

  const models = useMemo(() => flattenModels(bootstrap?.providers ?? []), [bootstrap]);
  const result = runState.result;
  const readyCount = models.filter((entry) => entry.model.available).length;
  const totalTokens =
    result?.responses.reduce((sum, response) => sum + (response.usage?.totalTokens ?? 0), 0) ?? 0;

  async function run() {
    const request: RunRequest = {
      prompt,
      mode,
      selectedModels,
      maxOutputTokens: 1200
    };
    setRunState(result ? { status: "loading", result } : { status: "loading" });
    try {
      setRunState({ status: "done", result: await createRun(request) });
    } catch (error) {
      setRunState({
        status: "error",
        ...(result ? { result } : {}),
        error: error instanceof Error ? error.message : "运行失败"
      });
    }
  }

  function toggleModel(key: string) {
    setSelectedModels((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  return (
    <main className={`chat-shell ${showInspector ? "with-inspector" : ""}`}>
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <button className="icon-button" title="折叠侧边栏">
            <PanelLeft size={19} />
          </button>
          <button className="new-chat-button">
            <MessageSquarePlus size={18} />
            新任务
          </button>
        </div>

        <div className="side-group">
          <p>项目</p>
          <button className="side-link active">
            <Activity size={17} />
            多模型工作台
          </button>
          <button className="side-link">
            <FileCode2 size={17} />
            工作区文件
          </button>
          <button className="side-link">
            <TerminalSquare size={17} />
            沙箱终端
          </button>
          <button className="side-link">
            <KeyRound size={17} />
            密钥与路由
          </button>
        </div>

        <div className="side-group history-group">
          <p>最近任务</p>
          <button className="history-item">设计 Web 版 Claude Code</button>
          <button className="history-item">拆解 Provider 网关</button>
          <button className="history-item">规划 Linux 沙箱部署</button>
        </div>

        <div className="sidebar-foot">
          <ShieldCheck size={17} />
          <span>默认审计 · 命令审批 · Linux 后端</span>
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-topbar">
          <button className="model-picker" type="button">
            Web Claude Code
            <ChevronDown size={17} />
          </button>
          <button className="icon-button" title="显示或隐藏检查器" onClick={() => setShowInspector((value) => !value)}>
            <Settings2 size={19} />
          </button>
        </header>

        <div className="conversation">
          <div className="assistant-message">
            <div className="avatar">W</div>
            <div className="message-body">
              <h1>今天要改哪块代码？</h1>
              <p>
                这个原型先把聊天入口、多模型编排、Provider 状态、工具权限和审计结果放在一个工作台里。后续接入真实工作区时，所有写文件和 shell
                都会先进入策略层。
              </p>
            </div>
          </div>

          <div className="user-message">
            <p>{prompt}</p>
          </div>

          <div className="assistant-message">
            <div className="avatar">A</div>
            <div className="message-body">
              <h2>编排结果</h2>
              <pre>{result?.final ?? "运行后，这里会展示多模型讨论和最终方案。"}</pre>
            </div>
          </div>

          {runState.status === "error" ? (
            <div className="inline-alert">
              <TriangleAlert size={18} />
              <span>{runState.error}</span>
            </div>
          ) : null}
        </div>

        <div className="composer-wrap">
          <div className="mode-strip">
            {(bootstrap?.modes ?? ["single", "race", "committee", "specialist"]).map((item) => (
              <ModeButton key={item} mode={item} current={mode} onClick={() => setMode(item)} />
            ))}
          </div>
          <div className="composer">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <button className="send-button" onClick={run} disabled={!bootstrap || runState.status === "loading"} title="运行">
              {runState.status === "loading" ? <Clock3 size={20} /> : <SendHorizonal size={20} />}
            </button>
          </div>
          <p className="composer-note">模型会先提出可审查方案；真实写文件、执行命令和联网操作将进入审批流。</p>
        </div>
      </section>

      {showInspector ? (
        <aside className="inspector">
          <section className="inspector-card">
            <div className="card-title">
              <Layers3 size={17} />
              <h2>模型池</h2>
            </div>
            <div className="stat-row">
              <span>{bootstrap?.providers.length ?? 0} 个接口</span>
              <span>{readyCount} 个可用</span>
              <span>{selectedModels.length} 个已选</span>
            </div>
            <div className="model-list">
              {models.map((entry) => (
                <ModelRow
                  key={entry.key}
                  providerName={entry.providerName}
                  model={entry.model}
                  checked={selectedModels.includes(entry.key)}
                  onToggle={() => toggleModel(entry.key)}
                />
              ))}
            </div>
          </section>

          <section className="inspector-card">
            <div className="card-title">
              <Code2 size={17} />
              <h2>工具权限</h2>
            </div>
            <div className="tool-list">
              {(bootstrap?.tools ?? []).map((tool) => (
                <div className="tool-item" key={tool.name}>
                  <strong>{tool.name}</strong>
                  <span>
                    {tool.permissions.filesystem ?? "fs:none"}
                    {tool.permissions.shell ? " · shell" : ""}
                    {tool.permissions.network ? " · network" : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="inspector-card">
            <div className="card-title">
              <ShieldCheck size={17} />
              <h2>审计</h2>
            </div>
            <div className="audit-list">
              {(result?.audit ?? []).map((event) => (
                <div className={`audit-event ${event.level}`} key={event.id}>
                  <strong>{event.label}</strong>
                  <span>{event.detail}</span>
                </div>
              ))}
              {!result ? <p className="empty">运行任务后会记录模型、工具和策略事件。</p> : null}
            </div>
            <div className="token-line">上次 token：{totalTokens}</div>
          </section>

          <button className="primary-run" onClick={run} disabled={!bootstrap || runState.status === "loading"}>
            {runState.status === "loading" ? <Clock3 size={18} /> : <Play size={18} />}
            {runState.status === "loading" ? "运行中" : "运行任务"}
          </button>
        </aside>
      ) : null}
    </main>
  );
}
