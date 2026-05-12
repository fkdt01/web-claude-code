import type { ServerResponse } from "node:http";
import cors from "@fastify/cors";
import Fastify from "fastify";
import type {
  OrchestrationMode,
  RunHistoryDetail,
  RunHistoryItem,
  RunRequest,
  RunResult,
  RunStreamEvent
} from "@webcode/core";
import { classifyShellCommand, defaultToolSpecs } from "@webcode/core";
import { orchestrateRun, previewRoute, providerPayload, streamRun } from "./orchestrator.js";
import { createProviderRegistry } from "./providers.js";
import { createWorkspaceService, WorkspaceError } from "./workspaces.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const patchPreviewBodyLimit = 1024 * 1024;
const maxOutputTokensLimit = 200_000;
const orchestrationModes = ["single", "race", "committee", "specialist"] as const satisfies readonly OrchestrationMode[];
const maxRunHistoryItems = 20;
const maxHistoryPromptLength = 140;
const maxHistoryPreviewLength = 180;
const maxHistoryTextLength = 6_000;
const providers = createProviderRegistry();
const workspaceService = await createWorkspaceService();
const runHistory = new Map<string, RunHistoryDetail>();
const runHistoryOrder: string[] = [];

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true
});

type WorkspaceParams = {
  workspaceId: string;
};

type RunHistoryParams = {
  runId: string;
};

type WorkspaceTreeQuery = {
  path?: string;
  depth?: string;
};

type WorkspaceFileQuery = {
  path?: string;
};

type WorkspaceSearchQuery = {
  query?: string;
  limit?: string;
};

type WorkspacePatchPreviewBody = {
  path?: string;
  newContent?: string;
};

type WorkspacePatchApplyBody = WorkspacePatchPreviewBody & {
  expectedHash?: string;
};

type WorkspaceShellRunBody = {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
};

type RoutePreviewBody = {
  prompt?: unknown;
  mode?: unknown;
  selectedModels?: unknown;
  workspaceId?: unknown;
  maxOutputTokens?: unknown;
};

const SECRET_VALUE_PATTERN = /((?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*)[^\s'",;]+/gi;
const BEARER_TOKEN_PATTERN = /(bearer\s+)[a-z0-9._-]+/gi;
const OPENAI_KEY_PATTERN = /sk-[a-z0-9_-]+/gi;

const maskSensitiveText = (value: string) =>
  value
    .replace(SECRET_VALUE_PATTERN, "$1[redacted]")
    .replace(BEARER_TOKEN_PATTERN, "$1[redacted]")
    .replace(OPENAI_KEY_PATTERN, "[redacted]");

function truncateText(value: string, maxLength: number) {
  const cleanValue = maskSensitiveText(value).replace(/\s+/g, " ").trim();
  if (cleanValue.length <= maxLength) return cleanValue;
  return `${cleanValue.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeRunForHistory(run: RunResult): RunResult {
  return {
    ...run,
    final: truncateText(run.final, maxHistoryTextLength),
    responses: run.responses.map((response) => ({
      ...response,
      text: truncateText(response.text, maxHistoryTextLength),
      ...(response.error ? { error: truncateText(response.error, maxHistoryPreviewLength) } : {})
    })),
    audit: run.audit.map((event) => ({
      ...event,
      detail: truncateText(event.detail, maxHistoryPreviewLength)
    }))
  };
}

function createRunHistoryItem(run: RunResult, request: RunRequest): RunHistoryItem {
  const totalTokens = run.responses.reduce((sum, response) => {
    const value = response.usage?.totalTokens;
    return Number.isFinite(value) ? sum + (value ?? 0) : sum;
  }, 0);
  const costValues = run.responses
    .map((response) => response.usage?.estimatedCostUsd)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const estimatedCostUsd =
    run.responses.length > 0 && costValues.length === run.responses.length
      ? Number(costValues.reduce((sum, value) => sum + value, 0).toFixed(8))
      : undefined;

  return {
    id: run.id,
    status: "completed",
    prompt: truncateText(request.prompt, maxHistoryPromptLength) || "Untitled run",
    mode: run.mode,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    selectedModels: [...run.selectedModels],
    responseCount: run.responses.length,
    totalTokens,
    finalPreview: truncateText(run.final, maxHistoryPreviewLength),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {})
  };
}

function recordRunHistory(run: RunResult, request: RunRequest) {
  const sanitizedRun = sanitizeRunForHistory(run);
  const detail: RunHistoryDetail = {
    item: createRunHistoryItem(sanitizedRun, request),
    run: sanitizedRun
  };
  runHistory.set(run.id, detail);
  runHistoryOrder.splice(0, runHistoryOrder.length, run.id, ...runHistoryOrder.filter((id) => id !== run.id));

  for (const staleId of runHistoryOrder.splice(maxRunHistoryItems)) {
    runHistory.delete(staleId);
  }
}

function sendWorkspaceError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof WorkspaceError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message
      }
    });
  }
  throw error;
}

function parseBoundedInteger(input: string | undefined, fallback: number, min: number, max: number) {
  if (!input) return fallback;
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new WorkspaceError("invalid_number", "Numeric query parameter is invalid.");
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeMode(value: unknown): OrchestrationMode {
  return typeof value === "string" && (orchestrationModes as readonly string[]).includes(value)
    ? (value as OrchestrationMode)
    : "committee";
}

function normalizeSelectedModels(value: unknown) {
  return Array.isArray(value)
    ? value.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    : [];
}

function normalizeMaxOutputTokens(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized < 1) return undefined;
  return Math.min(normalized, maxOutputTokensLimit);
}

function normalizeRunRequest(body: RunRequest): RunRequest {
  const maxOutputTokens = normalizeMaxOutputTokens(body.maxOutputTokens);
  return {
    prompt: body.prompt,
    mode: normalizeMode(body.mode),
    selectedModels: normalizeSelectedModels(body.selectedModels),
    ...(typeof body.workspaceId === "string" && body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
  };
}

async function prepareRunRequest(body: RunRequest): Promise<RunRequest> {
  const normalized = normalizeRunRequest(body);
  if (!normalized.workspaceId) return normalized;

  return {
    ...normalized,
    workspaceContext: await workspaceService.contextSummary(normalized.workspaceId)
  };
}

function normalizeRoutePreviewRequest(body: RoutePreviewBody | undefined): RunRequest {
  const maxOutputTokens = normalizeMaxOutputTokens(body?.maxOutputTokens);
  return {
    prompt: typeof body?.prompt === "string" ? body.prompt : "",
    mode: normalizeMode(body?.mode),
    selectedModels: normalizeSelectedModels(body?.selectedModels),
    ...(typeof body?.workspaceId === "string" && body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
  };
}

function writeSseEvent(raw: ServerResponse, event: RunStreamEvent) {
  raw.write(`event: ${event.type}\n`);
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

app.get("/api/health", async () => ({
  ok: true,
  at: new Date().toISOString()
}));

app.get("/api/providers", async () => ({
  providers: providerPayload(providers),
  modes: ["single", "race", "committee", "specialist"],
  tools: defaultToolSpecs
}));

app.post<{ Body: RoutePreviewBody }>("/api/routing/preview", async (request) =>
  previewRoute(normalizeRoutePreviewRequest(request.body), providers)
);

app.get("/api/runs/history", async () => ({
  runs: runHistoryOrder.flatMap((runId) => {
    const detail = runHistory.get(runId);
    return detail ? [detail.item] : [];
  })
}));

app.get<{ Params: RunHistoryParams }>("/api/runs/history/:runId", async (request, reply) => {
  const detail = runHistory.get(request.params.runId);
  if (!detail) {
    return reply.code(404).send({
      error: {
        code: "run_history_not_found",
        message: "Run history entry was not found."
      }
    });
  }

  return detail;
});

app.post<{ Body: RunRequest }>("/api/runs", async (request, reply) => {
  if (typeof request.body?.prompt !== "string" || !request.body.prompt.trim()) {
    return reply.code(400).send({ error: "prompt is required" });
  }

  try {
    const runRequest = await prepareRunRequest(request.body);
    const result = await orchestrateRun(runRequest, providers);
    recordRunHistory(result, runRequest);

    return result;
  } catch (error) {
    return sendWorkspaceError(reply, error);
  }
});

app.post<{ Body: RunRequest }>("/api/runs/stream", async (request, reply) => {
  if (typeof request.body?.prompt !== "string" || !request.body.prompt.trim()) {
    return reply.code(400).send({ error: "prompt is required" });
  }

  let runRequest: RunRequest;
  try {
    runRequest = await prepareRunRequest(request.body);
  } catch (error) {
    return sendWorkspaceError(reply, error);
  }

  reply.hijack();
  const abortController = new AbortController();
  const abortStream = () => abortController.abort();
  reply.raw.on("close", abortStream);
  reply.raw.on("error", abortStream);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  reply.raw.write(": connected\n\n");

  try {
    for await (const event of streamRun(runRequest, providers, {
      signal: abortController.signal
    })) {
      if (reply.raw.destroyed || abortController.signal.aborted) {
        abortController.abort();
        return;
      }
      writeSseEvent(reply.raw, event);
      if (event.type === "run_done") {
        recordRunHistory(event.run, runRequest);
      }
    }
  } catch (error) {
    if (!reply.raw.destroyed && !abortController.signal.aborted) {
      writeSseEvent(reply.raw, {
        type: "error",
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : "Unknown stream error"
      });
    }
  } finally {
    reply.raw.off("close", abortStream);
    reply.raw.off("error", abortStream);
    if (!reply.raw.destroyed) reply.raw.end();
  }
});

app.post<{ Body: { command?: string } }>("/api/policy/shell", async (request, reply) => {
  if (!request.body?.command?.trim()) {
    return reply.code(400).send({ error: "command is required" });
  }

  return classifyShellCommand(request.body.command);
});

app.get("/api/workspaces", async () => ({
  allowedRoots: workspaceService.listAllowedRoots(),
  workspaces: workspaceService.listWorkspaces()
}));

app.post<{ Body: { root?: string; name?: string } }>("/api/workspaces", async (request, reply) => {
  if (!request.body?.root?.trim()) {
    return reply.code(400).send({
      error: {
        code: "workspace_root_required",
        message: "workspace root is required"
      }
    });
  }

  try {
    return {
      workspace: await workspaceService.register(request.body.root, request.body.name)
    };
  } catch (error) {
    return sendWorkspaceError(reply, error);
  }
});

app.get<{ Params: WorkspaceParams; Querystring: WorkspaceTreeQuery }>(
  "/api/workspaces/:workspaceId/tree",
  async (request, reply) => {
    try {
      return await workspaceService.tree(
        request.params.workspaceId,
        request.query.path ?? ".",
        parseBoundedInteger(request.query.depth, 3, 0, 6)
      );
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  }
);

app.get<{ Params: WorkspaceParams; Querystring: WorkspaceFileQuery }>(
  "/api/workspaces/:workspaceId/files",
  async (request, reply) => {
    if (!request.query.path?.trim()) {
      return reply.code(400).send({
        error: {
          code: "file_path_required",
          message: "file path is required"
        }
      });
    }

    try {
      return {
        file: await workspaceService.readFile(request.params.workspaceId, request.query.path)
      };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  }
);

app.get<{ Params: WorkspaceParams; Querystring: WorkspaceSearchQuery }>(
  "/api/workspaces/:workspaceId/search",
  async (request, reply) => {
    if (!request.query.query?.trim()) {
      return reply.code(400).send({
        error: {
          code: "query_required",
          message: "search query is required"
        }
      });
    }

    try {
      return await workspaceService.search(
        request.params.workspaceId,
        request.query.query,
        parseBoundedInteger(request.query.limit, 50, 1, 100)
      );
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  }
);

app.post<{ Params: WorkspaceParams; Body: WorkspacePatchPreviewBody }>(
  "/api/workspaces/:workspaceId/patches/preview",
  { bodyLimit: patchPreviewBodyLimit },
  async (request, reply) => {
    if (!request.body?.path?.trim()) {
      return reply.code(400).send({
        error: {
          code: "file_path_required",
          message: "file path is required"
        }
      });
    }

    if (typeof request.body.newContent !== "string") {
      return reply.code(400).send({
        error: {
          code: "patch_content_required",
          message: "patch preview content is required"
        }
      });
    }

    try {
      return await workspaceService.previewPatch(request.params.workspaceId, request.body.path, request.body.newContent);
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  }
);

app.post<{ Params: WorkspaceParams; Body: WorkspacePatchApplyBody }>(
  "/api/workspaces/:workspaceId/patches/apply",
  { bodyLimit: patchPreviewBodyLimit },
  async (request, reply) => {
    if (!request.body?.path?.trim()) {
      return reply.code(400).send({
        error: {
          code: "file_path_required",
          message: "file path is required"
        }
      });
    }

    if (typeof request.body.newContent !== "string") {
      return reply.code(400).send({
        error: {
          code: "patch_content_required",
          message: "patch apply content is required"
        }
      });
    }

    if (typeof request.body.expectedHash !== "string" || !request.body.expectedHash.trim()) {
      return reply.code(400).send({
        error: {
          code: "patch_hash_required",
          message: "patch apply base hash is required"
        }
      });
    }

    try {
      return await workspaceService.applyPatch(
        request.params.workspaceId,
        request.body.path,
        request.body.newContent,
        request.body.expectedHash
      );
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  }
);

app.post<{ Params: WorkspaceParams; Body: WorkspaceShellRunBody }>(
  "/api/workspaces/:workspaceId/shell",
  async (request, reply) => {
    if (!request.body?.command?.trim()) {
      return reply.code(400).send({
        error: {
          code: "shell_command_required",
          message: "shell command is required"
        }
      });
    }

    try {
      return await workspaceService.runShell(
        request.params.workspaceId,
        request.body.command,
        request.body.cwd ?? ".",
        request.body.timeoutMs
      );
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  }
);

app.get<{ Params: WorkspaceParams }>("/api/workspaces/:workspaceId/audit", async (request, reply) => {
  try {
    return {
      audit: workspaceService.auditFor(request.params.workspaceId)
    };
  } catch (error) {
    return sendWorkspaceError(reply, error);
  }
});

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`API server listening on http://${host}:${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
