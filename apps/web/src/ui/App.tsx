import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Code2,
  FileText,
  FileCode2,
  FolderTree,
  KeyRound,
  Layers3,
  MessageSquarePlus,
  PanelLeft,
  Play,
  Search,
  SendHorizonal,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  TriangleAlert,
  XCircle
} from "lucide-react";
import type {
  ModelDescriptor,
  OrchestrationMode,
  RunRequest,
  WorkspaceAuditEvent,
  WorkspaceDescriptor,
  WorkspaceFileRead,
  WorkspacePatchPreview,
  WorkspaceSearchMatch,
  WorkspaceTreeEntry
} from "@webcode/core";
import { modelKey } from "@webcode/core";
import {
  createRun,
  loadBootstrap,
  loadWorkspaceAudit,
  loadWorkspaceTree,
  loadWorkspaces,
  previewWorkspacePatch,
  readWorkspaceFile,
  registerWorkspace,
  searchWorkspace
} from "./api";
import type { BootstrapPayload, ProviderPayload, UiRunState } from "./types";

const DEFAULT_PROMPT =
  "帮我设计一个 Web 版 Claude Code：支持多模型、可审查文件编辑、命令审批、审计日志，并优先考虑 Linux 后端部署。";

const SECRET_VALUE_PATTERN = /((?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*)[^\s'",;]+/gi;
const BEARER_TOKEN_PATTERN = /(bearer\s+)[a-z0-9._-]+/gi;
const OPENAI_KEY_PATTERN = /sk-[a-z0-9_-]+/gi;

function maskSensitiveText(value: string) {
  return value
    .replace(SECRET_VALUE_PATTERN, "$1[已脱敏]")
    .replace(BEARER_TOKEN_PATTERN, "$1[已脱敏]")
    .replace(OPENAI_KEY_PATTERN, "[已脱敏]");
}

function maskWorkspaceError(error: unknown, fallback: string) {
  return maskSensitiveText(error instanceof Error ? error.message : fallback);
}

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

function TreeNode({
  entry,
  selectedPath,
  onOpen
}: {
  entry: WorkspaceTreeEntry;
  selectedPath: string | undefined;
  onOpen: (entry: WorkspaceTreeEntry) => void;
}) {
  const isFile = entry.kind === "file";
  const isSelected = selectedPath === entry.path;

  return (
    <div className="tree-node">
      <button
        className={`tree-item ${isSelected ? "active" : ""}`}
        type="button"
        onClick={() => {
          if (isFile) onOpen(entry);
        }}
        disabled={!isFile}
        title={entry.path}
      >
        {isFile ? <FileText size={14} /> : <FolderTree size={14} />}
        <span>{entry.name}</span>
        {entry.size ? <small>{Math.ceil(entry.size / 1024)} KB</small> : null}
      </button>
      {entry.children?.length ? (
        <div className="tree-children">
          {entry.children.map((child) => (
            <TreeNode key={child.path} entry={child} selectedPath={selectedPath} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [mode, setMode] = useState<OrchestrationMode>("committee");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [runState, setRunState] = useState<UiRunState>({ status: "idle" });
  const [showInspector, setShowInspector] = useState(true);
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceTreeEntry | null>(null);
  const [workspaceFile, setWorkspaceFile] = useState<WorkspaceFileRead | null>(null);
  const [workspaceAudit, setWorkspaceAudit] = useState<WorkspaceAuditEvent[]>([]);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<WorkspaceSearchMatch[]>([]);
  const [workspaceSearchSubmitted, setWorkspaceSearchSubmitted] = useState(false);
  const [patchDraft, setPatchDraft] = useState("");
  const [patchPreview, setPatchPreview] = useState<WorkspacePatchPreview | null>(null);
  const [patchPreviewError, setPatchPreviewError] = useState<string | null>(null);
  const [patchPreviewLoading, setPatchPreviewLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const workspaceFilePathRef = useRef<string | null>(null);

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

  useEffect(() => {
    async function bootstrapWorkspace() {
      setWorkspaceLoading(true);
      setWorkspaceError(null);
      try {
        const payload = await loadWorkspaces();
        const current =
          payload.workspaces[0] ??
          (payload.allowedRoots[0]
            ? (await registerWorkspace(payload.allowedRoots[0], "默认工作区")).workspace
            : undefined);

        if (!current) {
          setWorkspaceError("后端没有配置可注册的工作区根目录。");
          return;
        }

        const treePayload = await loadWorkspaceTree(current.id, ".", 2);
        const auditPayload = await loadWorkspaceAudit(current.id);
        setWorkspace(current);
        setWorkspaceTree(treePayload.root);
        setWorkspaceAudit(auditPayload.audit);
      } catch (error) {
        setWorkspaceError(maskWorkspaceError(error, "加载工作区失败"));
      } finally {
        setWorkspaceLoading(false);
      }
    }

    void bootstrapWorkspace();
  }, []);

  useEffect(() => {
    workspaceFilePathRef.current = workspaceFile?.path ?? null;
  }, [workspaceFile]);

  const models = useMemo(() => flattenModels(bootstrap?.providers ?? []), [bootstrap]);
  const result = runState.result;
  const readyCount = models.filter((entry) => entry.model.available).length;
  const totalTokens =
    result?.responses.reduce((sum, response) => sum + (response.usage?.totalTokens ?? 0), 0) ?? 0;
  const workspaceFileHasSensitiveContent = useMemo(
    () => (workspaceFile ? maskSensitiveText(workspaceFile.content) !== workspaceFile.content : false),
    [workspaceFile]
  );

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

  async function openWorkspacePath(path: string) {
    if (!workspace || workspaceLoading) return;

    setWorkspaceLoading(true);
    setWorkspaceError(null);
    setWorkspaceFile(null);
    setPatchDraft("");
    setPatchPreview(null);
    setPatchPreviewError(null);
    try {
      const filePayload = await readWorkspaceFile(workspace.id, path);
      const auditPayload = await loadWorkspaceAudit(workspace.id);
      const nextFile = filePayload.file;
      const hasSensitiveContent = maskSensitiveText(nextFile.content) !== nextFile.content;
      setWorkspaceFile(nextFile);
      setPatchDraft(hasSensitiveContent ? "" : nextFile.content);
      setPatchPreviewError(hasSensitiveContent ? "检测到疑似敏感内容，修改草稿已禁用。" : null);
      setWorkspaceAudit(auditPayload.audit);
    } catch (error) {
      setWorkspaceError(maskWorkspaceError(error, "读取文件失败"));
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function openWorkspaceFile(entry: WorkspaceTreeEntry) {
    if (entry.kind !== "file") return;
    await openWorkspacePath(entry.path);
  }

  async function runWorkspaceSearch() {
    const query = workspaceSearchQuery.trim();
    if (!workspace || workspaceLoading || !query) return;

    setWorkspaceLoading(true);
    setWorkspaceError(null);
    setWorkspaceSearchResults([]);
    setWorkspaceSearchSubmitted(false);
    try {
      const result = await searchWorkspace(workspace.id, query, 20);
      const auditPayload = await loadWorkspaceAudit(workspace.id);
      setWorkspaceSearchResults(result.matches);
      setWorkspaceSearchSubmitted(true);
      setWorkspaceAudit(auditPayload.audit);
    } catch (error) {
      setWorkspaceSearchResults([]);
      setWorkspaceError(maskWorkspaceError(error, "搜索失败"));
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function runPatchPreview() {
    if (!workspace || !workspaceFile || workspaceLoading || patchPreviewLoading || workspaceFileHasSensitiveContent) return;

    const previewPath = workspaceFile.path;
    setPatchPreviewLoading(true);
    setPatchPreviewError(null);
    try {
      const result = await previewWorkspacePatch(workspace.id, previewPath, patchDraft);
      const auditPayload = await loadWorkspaceAudit(workspace.id);
      if (workspaceFilePathRef.current !== previewPath) return;
      setPatchPreview(result);
      setWorkspaceAudit(auditPayload.audit);
    } catch (error) {
      if (workspaceFilePathRef.current !== previewPath) return;
      setPatchPreview(null);
      setPatchPreviewError(maskWorkspaceError(error, "预览修改失败"));
    } finally {
      setPatchPreviewLoading(false);
    }
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

          <section className="inspector-card workspace-card">
            <div className="card-title">
              <FileCode2 size={17} />
              <h2>工作区</h2>
            </div>
            <div className="workspace-head">
              <strong>{workspace?.name ?? "未注册"}</strong>
              <span>{workspaceLoading ? "同步中" : "只读模式"}</span>
            </div>
            {workspaceError ? (
              <div className="workspace-error">
                <TriangleAlert size={15} />
                <span>{workspaceError}</span>
              </div>
            ) : null}
            <div className="workspace-browser">
              <div className="workspace-search">
                <input
                  value={workspaceSearchQuery}
                  onChange={(event) => {
                    setWorkspaceSearchQuery(event.target.value);
                    setWorkspaceSearchResults([]);
                    setWorkspaceSearchSubmitted(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && workspace && !workspaceLoading && workspaceSearchQuery.trim()) {
                      void runWorkspaceSearch();
                    }
                  }}
                  placeholder="搜索工作区"
                />
                <button
                  type="button"
                  onClick={() => void runWorkspaceSearch()}
                  disabled={!workspace || workspaceLoading || !workspaceSearchQuery.trim()}
                  title="搜索工作区"
                >
                  <Search size={15} />
                </button>
              </div>
              {workspaceSearchResults.length ? (
                <div className="search-results">
                  {workspaceSearchResults.map((match) => (
                    <button
                      className="search-result"
                      key={`${match.path}:${match.line}:${match.preview}`}
                      type="button"
                      onClick={() => void openWorkspacePath(match.path)}
                      disabled={workspaceLoading}
                      title={`${match.path}:${match.line}`}
                    >
                      <strong>{match.path}</strong>
                      <span>
                        {match.line}: {maskSensitiveText(match.preview)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {workspaceSearchSubmitted && !workspaceSearchResults.length ? <p className="empty">未找到匹配结果。</p> : null}
              <div className="tree-panel">
                {workspaceTree ? (
                  <TreeNode entry={workspaceTree} selectedPath={workspaceFile?.path} onOpen={openWorkspaceFile} />
                ) : (
                  <p className="empty">正在加载文件树。</p>
                )}
              </div>
              <div className="file-preview">
                <div className="file-preview-title">
                  <strong>{workspaceFile?.path ?? "选择文件预览"}</strong>
                  {workspaceFile ? <span>{workspaceFile.size} bytes</span> : null}
                </div>
                <pre>{workspaceFile ? maskSensitiveText(workspaceFile.content) : "文件内容会以只读方式显示在这里。"}</pre>
              </div>
              <div className="patch-preview">
                <div className="file-preview-title">
                  <strong>修改草稿</strong>
                  <span>{patchPreviewLoading ? "预览中" : patchPreview ? (patchPreview.changed ? "待审批" : "无变化") : "未预览"}</span>
                </div>
                {workspaceFile ? (
                  <>
                    <textarea
                      className="patch-draft"
                      value={patchDraft}
                      onChange={(event) => {
                        setPatchDraft(event.target.value);
                        setPatchPreview(null);
                        setPatchPreviewError(null);
                      }}
                      disabled={workspaceFileHasSensitiveContent || workspaceLoading || patchPreviewLoading}
                      placeholder={workspaceFileHasSensitiveContent ? "疑似敏感内容，暂不进入修改草稿。" : "在这里编辑文件内容后预览 diff。"}
                    />
                    <div className="patch-actions">
                      <button
                        type="button"
                        onClick={() => void runPatchPreview()}
                        disabled={!workspace || workspaceLoading || patchPreviewLoading || workspaceFileHasSensitiveContent}
                      >
                        <Code2 size={14} />
                        预览修改
                      </button>
                      {patchPreview ? <span>{patchPreview.updatedSize} bytes</span> : null}
                    </div>
                    {patchPreviewError ? (
                      <div className="workspace-error">
                        <TriangleAlert size={15} />
                        <span>{patchPreviewError}</span>
                      </div>
                    ) : null}
                    {patchPreview ? (
                      <div className="diff-panel">
                        <div className="diff-summary">
                          <span>{patchPreview.changed ? "等待审批，不会写入文件" : "内容没有变化"}</span>
                          {patchPreview.truncated ? <span>diff 已截断</span> : null}
                        </div>
                        <div className="diff-lines">
                          {patchPreview.diff.length ? (
                            patchPreview.diff.map((line, index) => (
                              <div className={`diff-line ${line.type}`} key={`${line.type}:${line.oldLine}:${line.newLine}:${index}`}>
                                <span className="diff-sign">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
                                <span className="diff-gutter">{line.oldLine ?? ""}</span>
                                <span className="diff-gutter">{line.newLine ?? ""}</span>
                                <code>{maskSensitiveText(line.content)}</code>
                              </div>
                            ))
                          ) : (
                            <p className="empty">没有内容变化。</p>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="empty">选择文件后可以预览修改 diff。</p>
                )}
              </div>
            </div>
          </section>

          <section className="inspector-card">
            <div className="card-title">
              <ShieldCheck size={17} />
              <h2>审计</h2>
            </div>
            <div className="audit-list">
              {workspaceAudit.slice(-5).map((event) => (
                <div className={`audit-event ${event.status === "denied" ? "blocked" : event.status}`} key={event.id}>
                  <strong>{event.action}</strong>
                  <span>
                    {maskSensitiveText(event.target ?? ".")} · {maskSensitiveText(event.detail)}
                  </span>
                </div>
              ))}
              {(result?.audit ?? []).map((event) => (
                <div className={`audit-event ${event.level}`} key={event.id}>
                  <strong>{event.label}</strong>
                  <span>{maskSensitiveText(event.detail)}</span>
                </div>
              ))}
              {!result && !workspaceAudit.length ? <p className="empty">运行任务后会记录模型、工具和策略事件。</p> : null}
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
