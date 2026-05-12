import type { ModelDescriptor, OrchestrationMode, RunResult, ToolSpec } from "@webcode/core";

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
