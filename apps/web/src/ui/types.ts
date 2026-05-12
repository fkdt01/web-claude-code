import type {
  ModelDescriptor,
  OrchestrationMode,
  RoutePreview,
  RunHistoryDetail,
  RunHistoryItem,
  RunResult,
  ToolSpec,
  WorkspaceAuditEvent,
  WorkspaceDescriptor,
  WorkspaceFileRead,
  WorkspacePatchApplyResult,
  WorkspacePatchPreview,
  WorkspaceSearchResult,
  WorkspaceShellPreflight,
  WorkspaceShellRunResult,
  WorkspaceTreeEntry
} from "@webcode/core";

export type ProviderPayload = {
  id: string;
  displayName: string;
  models: ModelDescriptor[];
};

export type BootstrapPayload = {
  providers: ProviderPayload[];
  modes: OrchestrationMode[];
  tools: ToolSpec[];
};

export type UiRunState =
  | { status: "idle"; result?: RunResult; error?: undefined }
  | { status: "loading"; result?: RunResult; error?: undefined }
  | { status: "error"; result?: RunResult; error: string }
  | { status: "done"; result: RunResult; error?: undefined };

export type WorkspaceBootstrapPayload = {
  allowedRoots: string[];
  workspaces: WorkspaceDescriptor[];
};

export type WorkspaceTreePayload = {
  workspace: WorkspaceDescriptor;
  root: WorkspaceTreeEntry;
};

export type WorkspaceFilePayload = {
  file: WorkspaceFileRead;
};

export type WorkspaceSearchPayload = WorkspaceSearchResult;

export type WorkspacePatchPreviewPayload = WorkspacePatchPreview;

export type WorkspacePatchApplyPayload = WorkspacePatchApplyResult;

export type WorkspaceShellPreviewPayload = WorkspaceShellPreflight;

export type WorkspaceShellRunPayload = WorkspaceShellRunResult;

export type RoutePreviewPayload = RoutePreview;

export type RunHistoryPayload = {
  runs: RunHistoryItem[];
};

export type RunHistoryDetailPayload = RunHistoryDetail;

export type WorkspaceAuditPayload = {
  audit: WorkspaceAuditEvent[];
};
