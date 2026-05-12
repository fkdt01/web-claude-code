export type ProviderId = "mock" | "anthropic" | "openai" | "openrouter" | "gemini" | string;

export type OrchestrationMode = "single" | "race" | "committee" | "specialist";

export type AgentRole = "planner" | "coder" | "reviewer" | "generalist";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "file"; name: string; text?: string; uri?: string };

export type UnifiedMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
};

export type ModelCapabilities = {
  streaming: boolean;
  toolCalls: boolean;
  vision: boolean;
  jsonMode: boolean;
  contextWindow: number;
};

export type ModelCost = {
  inputPerMillion?: number;
  outputPerMillion?: number;
  currency?: "USD" | string;
};

export type ModelDescriptor = {
  id: string;
  provider: ProviderId;
  label: string;
  role: AgentRole;
  available: boolean;
  capabilities: ModelCapabilities;
  cost?: ModelCost;
};

export type ToolPermission = {
  filesystem?: "none" | "read" | "write";
  shell?: boolean;
  network?: boolean;
  secrets?: boolean;
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions: ToolPermission;
};

export type UnifiedChatRequest = {
  runId: string;
  model: ModelDescriptor;
  messages: UnifiedMessage[];
  signal?: AbortSignal;
  tools?: ToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelEvent =
  | { type: "message_delta"; runId: string; modelKey: string; text: string }
  | { type: "tool_call"; runId: string; modelKey: string; call: ToolCall }
  | { type: "usage"; runId: string; modelKey: string; usage: TokenUsage }
  | { type: "error"; runId: string; modelKey: string; message: string; retryable: boolean }
  | { type: "done"; runId: string; modelKey: string };

export type ProviderAdapter = {
  id: ProviderId;
  displayName: string;
  models(): ModelDescriptor[];
  chat(request: UnifiedChatRequest): AsyncIterable<ModelEvent>;
};

export type WorkspaceRunContext = {
  workspaceId: string;
  name: string;
  treeLines: string[];
  truncated: boolean;
};

export type RunRequest = {
  prompt: string;
  mode: OrchestrationMode;
  selectedModels: string[];
  workspaceId?: string;
  workspaceContext?: WorkspaceRunContext;
  maxOutputTokens?: number;
};

export type ModelRunResult = {
  modelKey: string;
  provider: ProviderId;
  model: string;
  role: AgentRole;
  ok: boolean;
  text: string;
  usage?: TokenUsage;
  error?: string;
};

export type AuditEvent = {
  id: string;
  level: "info" | "warning" | "blocked";
  label: string;
  detail: string;
  at: string;
};

export type RunResult = {
  id: string;
  mode: OrchestrationMode;
  startedAt: string;
  completedAt: string;
  selectedModels: string[];
  final: string;
  responses: ModelRunResult[];
  audit: AuditEvent[];
};

export type RunHistoryItem = {
  id: string;
  status: "completed";
  prompt: string;
  mode: OrchestrationMode;
  startedAt: string;
  completedAt: string;
  selectedModels: string[];
  responseCount: number;
  totalTokens: number;
  finalPreview: string;
  estimatedCostUsd?: number;
};

export type RunHistoryDetail = {
  item: RunHistoryItem;
  run: RunResult;
};

export type RoutePreviewModel = {
  key: string;
  provider: ProviderId;
  model: string;
  label: string;
  role: AgentRole;
  available: boolean;
  estimatedMaxOutputCostUsd?: number;
};

export type RoutePreview = {
  mode: OrchestrationMode;
  maxOutputTokens: number;
  requestedModels: string[];
  selectedModels: string[];
  unknownModels: string[];
  unavailableModels: string[];
  unknownCostModels: string[];
  unknownCostCount: number;
  fallbackUsed: boolean;
  models: RoutePreviewModel[];
  estimatedMaxOutputCostUsd?: number;
};

export type RunStreamEvent =
  | {
      type: "run_started";
      runId: string;
      at: string;
      mode: OrchestrationMode;
      selectedModels: string[];
      audit: AuditEvent[];
    }
  | {
      type: "model_started";
      runId: string;
      at: string;
      modelKey: string;
      provider: ProviderId;
      model: string;
      role: AgentRole;
    }
  | {
      type: "model_event";
      runId: string;
      at: string;
      modelKey: string;
      event: ModelEvent;
    }
  | {
      type: "model_done";
      runId: string;
      at: string;
      result: ModelRunResult;
    }
  | {
      type: "run_done";
      at: string;
      run: RunResult;
    }
  | {
      type: "error";
      runId?: string;
      at: string;
      message: string;
    };

export type WorkspaceDescriptor = {
  id: string;
  name: string;
  root: string;
  createdAt: string;
};

export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size?: number;
  children?: WorkspaceTreeEntry[];
};

export type WorkspaceAuditEvent = {
  id: string;
  at: string;
  workspaceId: string;
  action:
    | "register_workspace"
    | "file_tree"
    | "read_file"
    | "search_workspace"
    | "preview_patch"
    | "apply_patch"
    | "run_shell";
  status: "allowed" | "denied" | "error";
  target?: string;
  detail: string;
};

export type WorkspaceFileRead = {
  workspaceId: string;
  path: string;
  size: number;
  content: string;
};

export type WorkspaceSearchMatch = {
  path: string;
  line: number;
  preview: string;
};

export type WorkspaceSearchResult = {
  workspaceId: string;
  query: string;
  matches: WorkspaceSearchMatch[];
};

export type WorkspaceDiffLine = {
  type: "context" | "add" | "remove";
  content: string;
  oldLine?: number;
  newLine?: number;
};

export type WorkspacePatchPreview = {
  workspaceId: string;
  path: string;
  previewToken: string;
  previewExpiresAt: string;
  baseHash: string;
  originalSize: number;
  updatedSize: number;
  changed: boolean;
  truncated: boolean;
  diff: WorkspaceDiffLine[];
};

export type WorkspacePatchApplyResult = {
  workspaceId: string;
  path: string;
  appliedAt: string;
  previousHash: string;
  nextHash: string;
  previousSize: number;
  nextSize: number;
  changed: boolean;
};

export type ShellPolicyDecision = {
  action: "allow" | "confirm" | "deny";
  risk: "low" | "medium" | "high";
  reason: string;
};

export type WorkspaceShellCommandHint = {
  name: string;
  usage: string;
  description: string;
};

export type WorkspaceShellPreflight = {
  workspaceId: string;
  command: string;
  cwd: string;
  enabled: boolean;
  allowed: boolean;
  reason: string;
  code?: string;
  policy: ShellPolicyDecision;
  commands: WorkspaceShellCommandHint[];
  limits: {
    commandLengthMax: number;
    timeoutMsMax: number;
    outputBytesMax: number;
  };
};

export type WorkspaceShellRunResult = {
  workspaceId: string;
  command: string;
  cwd: string;
  startedAt: string;
  completedAt: string;
  timeoutMs: number;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  policy: ShellPolicyDecision;
};

export const modelKey = (model: Pick<ModelDescriptor, "provider" | "id">) => `${model.provider}:${model.id}`;

export const textFromContent = (content: ContentPart[]) =>
  content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "file") return part.text ? `File ${part.name}:\n${part.text}` : `File ${part.name}`;
      return `[${part.mimeType} image]`;
    })
    .join("\n");
