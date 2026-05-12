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
  ModelCost,
  ModelRunResult,
  OrchestrationMode,
  RoutePreview,
  RunHistoryItem,
  RunRequest,
  RunResult,
  RunStreamEvent,
  WorkspaceAuditEvent,
  WorkspaceDescriptor,
  WorkspaceFileRead,
  WorkspacePatchPreview,
  WorkspaceSearchMatch,
  WorkspaceShellRunResult,
  WorkspaceTreeEntry
} from "@webcode/core";
import { modelKey } from "@webcode/core";
import {
  applyWorkspacePatch,
  loadBootstrap,
  loadRunHistory,
  loadRunHistoryDetail,
  loadWorkspaceAudit,
  loadWorkspaceTree,
  loadWorkspaces,
  previewWorkspacePatch,
  previewRoute,
  readWorkspaceFile,
  registerWorkspace,
  runWorkspaceShell,
  searchWorkspace,
  streamRun
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

function formatUsd(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "未配置";
  if (value > 0 && value < 0.000001) return "<$0.000001";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 6 : 4,
    maximumFractionDigits: value < 0.01 ? 6 : 4
  }).format(value);
}

function formatModelCost(cost: ModelCost | undefined) {
  if (!cost || (cost.currency && cost.currency !== "USD")) return "成本未配置";
  const input = formatUsd(cost.inputPerMillion);
  const output = formatUsd(cost.outputPerMillion);
  return `输入 ${input}/M · 输出 ${output}/M`;
}

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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
        <small>{formatModelCost(model.cost)}</small>
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
  expandedPaths,
  loadedPaths,
  loadingPaths,
  errors,
  onOpen,
  onToggleDirectory
}: {
  entry: WorkspaceTreeEntry;
  selectedPath: string | undefined;
  expandedPaths: Set<string>;
  loadedPaths: Set<string>;
  loadingPaths: Set<string>;
  errors: Record<string, string>;
  onOpen: (entry: WorkspaceTreeEntry) => void;
  onToggleDirectory: (entry: WorkspaceTreeEntry) => void;
}) {
  const isFile = entry.kind === "file";
  const isDirectory = entry.kind === "directory";
  const isSelected = selectedPath === entry.path;
  const isExpanded = expandedPaths.has(entry.path);
  const isLoading = loadingPaths.has(entry.path);
  const isLoadedDirectory = isDirectory && loadedPaths.has(entry.path);
  const error = errors[entry.path];

  return (
    <div className="tree-node">
      <button
        className={`tree-item ${isSelected ? "active" : ""} ${isDirectory && isExpanded ? "expanded" : ""} ${isLoading ? "loading" : ""}`}
        type="button"
        onClick={() => {
          if (isFile) onOpen(entry);
          if (isDirectory) onToggleDirectory(entry);
        }}
        disabled={isLoading || (!isFile && !isDirectory)}
        title={entry.path}
      >
        <span className={`tree-chevron ${!isDirectory ? "placeholder" : isExpanded ? "expanded" : ""}`}>
          {isDirectory ? <ChevronDown size={13} /> : null}
        </span>
        {isFile ? <FileText size={14} /> : <FolderTree size={14} />}
        <span>{entry.name}</span>
        {isLoading ? (
          <small>加载中</small>
        ) : isFile && entry.size ? (
          <small>{Math.ceil(entry.size / 1024)} KB</small>
        ) : isLoadedDirectory ? (
          <small>{entry.children?.length ?? 0}</small>
        ) : null}
      </button>
      {error ? <p className="tree-error">{error}</p> : null}
      {isDirectory && isExpanded && entry.children?.length ? (
        <div className="tree-children">
          {entry.children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              loadedPaths={loadedPaths}
              loadingPaths={loadingPaths}
              errors={errors}
              onOpen={onOpen}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function collectLoadedDirectoryPaths(entry: WorkspaceTreeEntry, paths = new Set<string>()) {
  if (entry.kind === "directory" && Array.isArray(entry.children)) {
    paths.add(entry.path);
    for (const child of entry.children) collectLoadedDirectoryPaths(child, paths);
  }
  return paths;
}

function mergeTreeBranch(current: WorkspaceTreeEntry, branch: WorkspaceTreeEntry): WorkspaceTreeEntry {
  if (current.path === branch.path) return branch;
  if (!current.children?.length) return current;

  let changed = false;
  const children = current.children.map((child) => {
    const next = mergeTreeBranch(child, branch);
    if (next !== child) changed = true;
    return next;
  });

  return changed ? { ...current, children } : current;
}

function streamingFinal(responses: ModelRunResult[]) {
  if (!responses.length) return "正在连接模型流...";

  return responses
    .map((response) => {
      const title = `${response.provider}/${response.model} (${response.role})`;
      const body = response.text.trim() || (response.ok ? "正在生成..." : response.error ?? "模型没有返回内容");
      return `${title}\n${body}`;
    })
    .join("\n\n");
}

function withStreamingFinal(run: RunResult): RunResult {
  return {
    ...run,
    final: streamingFinal(run.responses)
  };
}

function replaceResponse(responses: ModelRunResult[], replacement: ModelRunResult) {
  const index = responses.findIndex((response) => response.modelKey === replacement.modelKey);
  if (index < 0) return [...responses, replacement];

  const next = [...responses];
  next[index] = replacement;
  return next;
}

function applyRunStreamEvent(current: RunResult | undefined, event: RunStreamEvent): RunResult | undefined {
  if (event.type === "run_started") {
    return {
      id: event.runId,
      mode: event.mode,
      startedAt: event.at,
      completedAt: event.at,
      selectedModels: event.selectedModels,
      final: "正在连接模型流...",
      responses: [],
      audit: event.audit
    };
  }

  if (!current) return undefined;

  if (event.type === "model_started") {
    if (current.responses.some((response) => response.modelKey === event.modelKey)) return current;

    return withStreamingFinal({
      ...current,
      completedAt: event.at,
      responses: [
        ...current.responses,
        {
          modelKey: event.modelKey,
          provider: event.provider,
          model: event.model,
          role: event.role,
          ok: true,
          text: ""
        }
      ]
    });
  }

  if (event.type === "model_event") {
    return withStreamingFinal({
      ...current,
      completedAt: event.at,
      responses: current.responses.map((response) => {
        if (response.modelKey !== event.modelKey) return response;
        if (event.event.type === "message_delta") return { ...response, text: response.text + event.event.text };
        if (event.event.type === "usage") return { ...response, usage: event.event.usage };
        if (event.event.type === "error") return { ...response, ok: false, error: event.event.message };
        return response;
      })
    });
  }

  if (event.type === "model_done") {
    return withStreamingFinal({
      ...current,
      completedAt: event.at,
      responses: replaceResponse(current.responses, event.result)
    });
  }

  if (event.type === "run_done") return event.run;

  return current;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [mode, setMode] = useState<OrchestrationMode>("committee");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const [routePreviewError, setRoutePreviewError] = useState<string | null>(null);
  const [routePreviewLoading, setRoutePreviewLoading] = useState(false);
  const [runState, setRunState] = useState<UiRunState>({ status: "idle" });
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([]);
  const [runHistoryError, setRunHistoryError] = useState<string | null>(null);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [workspaceTree, setWorkspaceTree] = useState<WorkspaceTreeEntry | null>(null);
  const [workspaceExpandedPaths, setWorkspaceExpandedPaths] = useState<Set<string>>(() => new Set());
  const [workspaceLoadedPaths, setWorkspaceLoadedPaths] = useState<Set<string>>(() => new Set());
  const [workspaceTreeLoadingPaths, setWorkspaceTreeLoadingPaths] = useState<Set<string>>(() => new Set());
  const [workspaceTreeErrors, setWorkspaceTreeErrors] = useState<Record<string, string>>({});
  const [workspaceFile, setWorkspaceFile] = useState<WorkspaceFileRead | null>(null);
  const [workspaceAudit, setWorkspaceAudit] = useState<WorkspaceAuditEvent[]>([]);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<WorkspaceSearchMatch[]>([]);
  const [workspaceSearchSubmitted, setWorkspaceSearchSubmitted] = useState(false);
  const [patchDraft, setPatchDraft] = useState("");
  const [patchPreview, setPatchPreview] = useState<WorkspacePatchPreview | null>(null);
  const [patchPreviewDraft, setPatchPreviewDraft] = useState<string | null>(null);
  const [patchPreviewError, setPatchPreviewError] = useState<string | null>(null);
  const [patchPreviewLoading, setPatchPreviewLoading] = useState(false);
  const [patchApplyLoading, setPatchApplyLoading] = useState(false);
  const [patchApplyMessage, setPatchApplyMessage] = useState<string | null>(null);
  const [shellCommand, setShellCommand] = useState("pwd");
  const [shellCwd, setShellCwd] = useState(".");
  const [shellResult, setShellResult] = useState<WorkspaceShellRunResult | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  const [shellLoading, setShellLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const workspaceIdRef = useRef<string | null>(null);
  const workspaceFilePathRef = useRef<string | null>(null);
  const patchDraftRef = useRef("");
  const patchPreviewRequestRef = useRef(0);
  const patchApplyRequestRef = useRef(0);
  const shellRequestRef = useRef(0);
  const routePreviewRequestRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);
  const runHistoryRequestRef = useRef(0);
  const runRequestRef = useRef(0);

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
        const loadedPaths = collectLoadedDirectoryPaths(treePayload.root);
        setWorkspaceLoadedPaths(loadedPaths);
        setWorkspaceExpandedPaths(new Set(loadedPaths));
        setWorkspaceTreeLoadingPaths(new Set());
        setWorkspaceTreeErrors({});
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
    workspaceIdRef.current = workspace?.id ?? null;
  }, [workspace]);

  useEffect(() => {
    workspaceFilePathRef.current = workspaceFile?.path ?? null;
  }, [workspaceFile]);

  useEffect(() => {
    patchDraftRef.current = patchDraft;
  }, [patchDraft]);

  useEffect(() => () => runAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!bootstrap) return;

    const requestId = routePreviewRequestRef.current + 1;
    routePreviewRequestRef.current = requestId;
    setRoutePreviewLoading(true);
    setRoutePreviewError(null);
    previewRoute({
      prompt: "",
      mode,
      selectedModels,
      maxOutputTokens: 1200
    })
      .then((preview) => {
        if (routePreviewRequestRef.current !== requestId) return;
        setRoutePreview(preview);
      })
      .catch((error) => {
        if (routePreviewRequestRef.current !== requestId) return;
        setRoutePreview(null);
        setRoutePreviewError(maskSensitiveText(error instanceof Error ? error.message : "路由预览失败"));
      })
      .finally(() => {
        if (routePreviewRequestRef.current === requestId) setRoutePreviewLoading(false);
      });
  }, [bootstrap, mode, selectedModels]);

  async function refreshRunHistory() {
    const requestId = runHistoryRequestRef.current + 1;
    runHistoryRequestRef.current = requestId;
    setRunHistoryLoading(true);
    setRunHistoryError(null);
    try {
      const payload = await loadRunHistory();
      if (runHistoryRequestRef.current !== requestId) return;
      setRunHistory(payload.runs);
    } catch (error) {
      if (runHistoryRequestRef.current !== requestId) return;
      setRunHistoryError(maskSensitiveText(error instanceof Error ? error.message : "加载历史失败"));
    } finally {
      if (runHistoryRequestRef.current === requestId) setRunHistoryLoading(false);
    }
  }

  useEffect(() => {
    void refreshRunHistory();
  }, []);

  const models = useMemo(() => flattenModels(bootstrap?.providers ?? []), [bootstrap]);
  const result = runState.result;
  const readyCount = models.filter((entry) => entry.model.available).length;
  const totalTokens =
    result?.responses.reduce((sum, response) => sum + (response.usage?.totalTokens ?? 0), 0) ?? 0;
  const costValues =
    result?.responses
      .map((response) => response.usage?.estimatedCostUsd)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? [];
  const totalEstimatedCost =
    costValues.length > 0 ? costValues.reduce((sum, value) => sum + value, 0) : undefined;
  const workspaceFileHasSensitiveContent = useMemo(
    () => (workspaceFile ? maskSensitiveText(workspaceFile.content) !== workspaceFile.content : false),
    [workspaceFile]
  );
  const patchPreviewMatchesDraft =
    Boolean(patchPreview && workspaceFile) && patchPreview?.path === workspaceFile?.path && patchPreviewDraft === patchDraft;
  const patchCanApply = Boolean(
    workspace &&
      workspaceFile &&
      patchPreview?.changed &&
      patchPreview.baseHash &&
      patchPreviewMatchesDraft &&
      !patchPreview.truncated &&
      !workspaceLoading &&
      !patchPreviewLoading &&
      !patchApplyLoading &&
      !workspaceFileHasSensitiveContent
  );

  async function openRunHistory(runId: string) {
    setRunHistoryLoading(true);
    setRunHistoryError(null);
    try {
      const detail = await loadRunHistoryDetail(runId);
      setRunState({ status: "done", result: detail.run });
      setRunHistory((current) => {
        const withoutCurrent = current.filter((item) => item.id !== detail.item.id);
        return [detail.item, ...withoutCurrent];
      });
    } catch (error) {
      setRunHistoryError(maskSensitiveText(error instanceof Error ? error.message : "加载历史详情失败"));
    } finally {
      setRunHistoryLoading(false);
    }
  }

  async function run() {
    const request: RunRequest = {
      prompt,
      mode,
      selectedModels,
      ...(workspace ? { workspaceId: workspace.id } : {}),
      maxOutputTokens: 1200
    };
    const requestId = runRequestRef.current + 1;
    runRequestRef.current = requestId;
    runAbortRef.current?.abort();
    const abortController = new AbortController();
    runAbortRef.current = abortController;
    setRunState(result ? { status: "loading", result } : { status: "loading" });
    try {
      const streamed = await streamRun(
        request,
        (event) => {
          if (runRequestRef.current !== requestId) return;
          setRunState((current) => {
            const next = applyRunStreamEvent(current.result, event);
            return next ? { status: "loading", result: next } : current;
          });
        },
        abortController.signal
      );
      if (runRequestRef.current !== requestId) return;
      setRunState({ status: "done", result: streamed });
      void refreshRunHistory();
    } catch (error) {
      if (abortController.signal.aborted) return;
      setRunState((current) => {
        const fallbackResult = current.result ?? result;
        const message = maskSensitiveText(error instanceof Error ? error.message : "运行失败");
        return fallbackResult
          ? { status: "error", result: fallbackResult, error: message }
          : { status: "error", error: message };
      });
    } finally {
      if (runAbortRef.current === abortController) runAbortRef.current = null;
    }
  }

  function toggleModel(key: string) {
    setSelectedModels((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  async function openWorkspacePath(path: string) {
    if (!workspace || workspaceLoading) return;

    workspaceFilePathRef.current = null;
    patchPreviewRequestRef.current += 1;
    patchApplyRequestRef.current += 1;
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    setWorkspaceFile(null);
    setPatchDraft("");
    setPatchPreview(null);
    setPatchPreviewDraft(null);
    setPatchPreviewError(null);
    setPatchPreviewLoading(false);
    setPatchApplyLoading(false);
    setPatchApplyMessage(null);
    setShellResult(null);
    setShellError(null);
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

  async function toggleWorkspaceDirectory(entry: WorkspaceTreeEntry) {
    if (!workspace || entry.kind !== "directory") return;

    const path = entry.path;
    if (workspaceLoadedPaths.has(path)) {
      setWorkspaceExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      return;
    }

    const workspaceId = workspace.id;
    setWorkspaceTreeLoadingPaths((current) => new Set(current).add(path));
    setWorkspaceTreeErrors((current) => {
      const { [path]: _error, ...rest } = current;
      return rest;
    });

    try {
      const [treePayload, auditPayload] = await Promise.all([
        loadWorkspaceTree(workspaceId, path, 1),
        loadWorkspaceAudit(workspaceId)
      ]);
      if (workspaceIdRef.current !== workspaceId) return;

      setWorkspaceTree((current) => (current ? mergeTreeBranch(current, treePayload.root) : treePayload.root));
      setWorkspaceLoadedPaths((current) => {
        const next = new Set(current);
        for (const loadedPath of collectLoadedDirectoryPaths(treePayload.root)) next.add(loadedPath);
        return next;
      });
      setWorkspaceExpandedPaths((current) => new Set(current).add(path));
      setWorkspaceAudit(auditPayload.audit);
    } catch (error) {
      if (workspaceIdRef.current !== workspaceId) return;
      setWorkspaceTreeErrors((current) => ({
        ...current,
        [path]: maskWorkspaceError(error, "目录加载失败")
      }));
    } finally {
      if (workspaceIdRef.current === workspaceId) {
        setWorkspaceTreeLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
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
    if (!workspace || !workspaceFile || workspaceLoading || patchPreviewLoading || patchApplyLoading || workspaceFileHasSensitiveContent) return;

    const previewPath = workspaceFile.path;
    const previewDraft = patchDraft;
    const requestId = patchPreviewRequestRef.current + 1;
    patchPreviewRequestRef.current = requestId;
    setPatchPreviewLoading(true);
    setPatchPreviewError(null);
    setPatchApplyMessage(null);
    try {
      const result = await previewWorkspacePatch(workspace.id, previewPath, previewDraft);
      const auditPayload = await loadWorkspaceAudit(workspace.id);
      if (
        patchPreviewRequestRef.current !== requestId ||
        workspaceFilePathRef.current !== previewPath ||
        patchDraftRef.current !== previewDraft
      ) {
        return;
      }
      setPatchPreview(result);
      setPatchPreviewDraft(previewDraft);
      setWorkspaceAudit(auditPayload.audit);
    } catch (error) {
      if (patchPreviewRequestRef.current !== requestId || workspaceFilePathRef.current !== previewPath) return;
      setPatchPreview(null);
      setPatchPreviewDraft(null);
      setPatchPreviewError(maskWorkspaceError(error, "预览修改失败"));
    } finally {
      if (patchPreviewRequestRef.current === requestId) {
        setPatchPreviewLoading(false);
      }
    }
  }

  async function runPatchApply() {
    if (!patchCanApply || !workspace || !workspaceFile || !patchPreview) return;

    if (!window.confirm(`应用对 ${patchPreview.path} 的修改？此操作会写入工作区文件。`)) return;

    const applyPath = workspaceFile.path;
    const applyDraft = patchDraft;
    const expectedHash = patchPreview.baseHash;
    const requestId = patchApplyRequestRef.current + 1;
    patchApplyRequestRef.current = requestId;
    setPatchApplyLoading(true);
    setPatchPreviewError(null);
    setPatchApplyMessage(null);
    try {
      const applied = await applyWorkspacePatch(workspace.id, applyPath, applyDraft, expectedHash);
      const [filePayload, treePayload, auditPayload] = await Promise.all([
        readWorkspaceFile(workspace.id, applyPath),
        loadWorkspaceTree(workspace.id, ".", 2),
        loadWorkspaceAudit(workspace.id)
      ]);
      if (patchApplyRequestRef.current !== requestId || workspaceFilePathRef.current !== applyPath) return;
      const nextFile = filePayload.file;
      const hasSensitiveContent = maskSensitiveText(nextFile.content) !== nextFile.content;
      const loadedPaths = collectLoadedDirectoryPaths(treePayload.root);
      setWorkspaceFile(nextFile);
      setPatchDraft(hasSensitiveContent ? "" : nextFile.content);
      setPatchPreview(null);
      setPatchPreviewDraft(null);
      setPatchPreviewError(hasSensitiveContent ? "检测到疑似敏感内容，修改草稿已禁用。" : null);
      setWorkspaceTree(treePayload.root);
      setWorkspaceLoadedPaths(loadedPaths);
      setWorkspaceExpandedPaths(new Set(loadedPaths));
      setWorkspaceTreeLoadingPaths(new Set());
      setWorkspaceTreeErrors({});
      setWorkspaceAudit(auditPayload.audit);
      setPatchApplyMessage(applied.changed ? "修改已应用，文件已刷新。" : "内容没有变化，文件已刷新。");
    } catch (error) {
      if (patchApplyRequestRef.current !== requestId || workspaceFilePathRef.current !== applyPath) return;
      setPatchPreview(null);
      setPatchPreviewDraft(null);
      setPatchPreviewError(maskWorkspaceError(error, "应用修改失败"));
      setPatchApplyMessage(null);
    } finally {
      if (patchApplyRequestRef.current === requestId) {
        setPatchApplyLoading(false);
      }
    }
  }

  async function runShellCommand() {
    const command = shellCommand.trim();
    if (!workspace || workspaceLoading || shellLoading || !command) return;

    const workspaceId = workspace.id;
    const requestId = shellRequestRef.current + 1;
    shellRequestRef.current = requestId;
    setShellLoading(true);
    setShellError(null);
    setShellResult(null);
    try {
      const result = await runWorkspaceShell(workspaceId, command, shellCwd.trim() || ".", 5000);
      if (shellRequestRef.current !== requestId || workspace?.id !== workspaceId) return;
      setShellResult(result);
      try {
        const auditPayload = await loadWorkspaceAudit(workspaceId);
        if (shellRequestRef.current !== requestId || workspace?.id !== workspaceId) return;
        setWorkspaceAudit(auditPayload.audit);
      } catch {
        setShellError("命令已完成，但审计刷新失败。");
      }
    } catch (error) {
      if (shellRequestRef.current !== requestId || workspace?.id !== workspaceId) return;
      setShellError(maskWorkspaceError(error, "shell 命令运行失败"));
      try {
        const auditPayload = await loadWorkspaceAudit(workspaceId);
        if (shellRequestRef.current !== requestId || workspace?.id !== workspaceId) return;
        setWorkspaceAudit(auditPayload.audit);
      } catch {
        // Keep the shell error visible even if the audit refresh fails.
      }
    } finally {
      if (shellRequestRef.current === requestId) setShellLoading(false);
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
          {runHistory.map((item) => (
            <button
              className={`history-item ${result?.id === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => void openRunHistory(item.id)}
              disabled={runHistoryLoading}
              title={item.prompt}
            >
              <strong>{item.prompt}</strong>
              <span>
                {formatHistoryTime(item.completedAt)} · {item.mode} · {item.selectedModels.length} 模型
              </span>
            </button>
          ))}
          {!runHistory.length && !runHistoryLoading ? <span className="history-empty">运行后会出现在这里</span> : null}
          {runHistoryLoading ? <span className="history-empty">历史同步中</span> : null}
          {runHistoryError ? <span className="history-error">{runHistoryError}</span> : null}
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
            <div className="route-preview">
              <div className="route-preview-head">
                <strong>路由预览</strong>
                <span>
                  {routePreviewLoading
                    ? "计算中"
                    : routePreview
                      ? `${routePreview.selectedModels.length} 个模型 · ${
                          routePreview.unknownCostCount
                            ? `${routePreview.unknownCostCount} 个成本未配置`
                            : formatUsd(routePreview.estimatedMaxOutputCostUsd)
                        }`
                      : "未就绪"}
                </span>
              </div>
              {routePreviewError ? (
                <div className="workspace-error">
                  <TriangleAlert size={15} />
                  <span>{routePreviewError}</span>
                </div>
              ) : null}
              {routePreview ? (
                <>
                  <div className="route-flags">
                    <span>{routePreview.mode}</span>
                    <span>{routePreview.fallbackUsed ? "fallback mock" : "按选择路由"}</span>
                    <span>{routePreview.maxOutputTokens} max tokens</span>
                    {routePreview.unknownCostCount ? <span>{routePreview.unknownCostCount} 个成本未配置</span> : null}
                  </div>
                  <div className="route-models">
                    {routePreview.models.map((model) => (
                      <span key={model.key}>
                        {model.provider}/{model.model} · {model.role}
                      </span>
                    ))}
                  </div>
                  {routePreview.unavailableModels.length || routePreview.unknownModels.length ? (
                    <p className="empty">
                      跳过：
                      {[...routePreview.unavailableModels, ...routePreview.unknownModels].join("、")}
                    </p>
                  ) : null}
                  {routePreview.unknownCostModels.length ? (
                    <p className="route-note">成本未配置：{routePreview.unknownCostModels.join("、")}</p>
                  ) : null}
                </>
              ) : null}
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
                  <TreeNode
                    entry={workspaceTree}
                    selectedPath={workspaceFile?.path}
                    expandedPaths={workspaceExpandedPaths}
                    loadedPaths={workspaceLoadedPaths}
                    loadingPaths={workspaceTreeLoadingPaths}
                    errors={workspaceTreeErrors}
                    onOpen={openWorkspaceFile}
                    onToggleDirectory={toggleWorkspaceDirectory}
                  />
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
                  <span>
                    {patchApplyLoading
                      ? "应用中"
                      : patchPreviewLoading
                        ? "预览中"
                        : patchApplyMessage
                          ? "已应用"
                          : patchPreview
                            ? patchPreview.changed
                              ? "待审批"
                              : "无变化"
                            : "未预览"}
                  </span>
                </div>
                {workspaceFile ? (
                  <>
                    <textarea
                      className="patch-draft"
                      value={patchDraft}
                      onChange={(event) => {
                        setPatchDraft(event.target.value);
                        setPatchPreview(null);
                        setPatchPreviewDraft(null);
                        setPatchPreviewError(null);
                        setPatchApplyMessage(null);
                      }}
                      disabled={workspaceFileHasSensitiveContent || workspaceLoading || patchPreviewLoading || patchApplyLoading}
                      placeholder={workspaceFileHasSensitiveContent ? "疑似敏感内容，暂不进入修改草稿。" : "在这里编辑文件内容后预览 diff。"}
                    />
                    <div className="patch-actions">
                      <button
                        type="button"
                        onClick={() => void runPatchPreview()}
                        disabled={!workspace || workspaceLoading || patchPreviewLoading || patchApplyLoading || workspaceFileHasSensitiveContent}
                      >
                        <Code2 size={14} />
                        预览修改
                      </button>
                      {patchPreview?.changed ? (
                        <button
                          className="apply-button"
                          type="button"
                          onClick={() => void runPatchApply()}
                          disabled={!patchCanApply}
                          title={
                            patchPreview.truncated
                              ? "预览已截断，不能应用。"
                              : patchPreviewMatchesDraft
                                ? "应用已预览的修改"
                                : "草稿已变化，请重新预览。"
                          }
                        >
                          <CheckCircle2 size={14} />
                          {patchApplyLoading ? "应用中" : "应用修改"}
                        </button>
                      ) : null}
                      {patchPreview ? <span>{patchPreview.updatedSize} bytes</span> : null}
                    </div>
                    {patchApplyMessage ? <p className="empty">{patchApplyMessage}</p> : null}
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
              <div className="shell-panel">
                <div className="file-preview-title">
                  <strong>只读 shell</strong>
                  <span>{shellLoading ? "运行中" : shellResult ? `exit ${shellResult.exitCode ?? "null"}` : "手动触发"}</span>
                </div>
                <div className="shell-controls">
                  <input
                    value={shellCommand}
                    onChange={(event) => {
                      setShellCommand(event.target.value);
                      setShellError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && workspace && !shellLoading && shellCommand.trim()) {
                        void runShellCommand();
                      }
                    }}
                    placeholder="pwd"
                  />
                  <input
                    value={shellCwd}
                    onChange={(event) => setShellCwd(event.target.value)}
                    placeholder="."
                    title="工作目录"
                  />
                  <button
                    type="button"
                    onClick={() => void runShellCommand()}
                    disabled={!workspace || workspaceLoading || shellLoading || !shellCommand.trim()}
                    title="运行只读 shell 命令"
                  >
                    <TerminalSquare size={15} />
                  </button>
                </div>
                {shellError ? (
                  <div className="workspace-error">
                    <TriangleAlert size={15} />
                    <span>{shellError}</span>
                  </div>
                ) : null}
                {shellResult ? (
                  <div className="shell-output">
                    <div className="diff-summary">
                      <span>
                        exit {shellResult.exitCode ?? "null"} · cwd {shellResult.cwd} · {shellResult.timedOut ? "已超时" : "已完成"}
                      </span>
                      {shellResult.truncated ? <span>输出已截断</span> : null}
                    </div>
                    <pre>{maskSensitiveText(shellResult.stdout || "stdout 为空。")}</pre>
                    {shellResult.stderr ? <pre className="shell-stderr">{maskSensitiveText(shellResult.stderr)}</pre> : null}
                  </div>
                ) : (
                  <p className="empty">仅调用后端受保护的手动 shell API；非 Linux 后端会返回禁用错误。</p>
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
            <div className="token-line">
              上次 token：{totalTokens} · 预估成本：{formatUsd(totalEstimatedCost)}
            </div>
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
