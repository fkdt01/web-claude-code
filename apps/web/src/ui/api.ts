import type { RunRequest, RunResult, RunStreamEvent } from "@webcode/core";
import type {
  BootstrapPayload,
  RoutePreviewPayload,
  RunHistoryDetailPayload,
  RunHistoryPayload,
  WorkspaceAuditPayload,
  WorkspaceBootstrapPayload,
  WorkspaceFilePayload,
  WorkspacePatchApplyPayload,
  WorkspacePatchPreviewPayload,
  WorkspaceSearchPayload,
  WorkspaceShellPreviewPayload,
  WorkspaceShellRunPayload,
  WorkspaceTreePayload
} from "./types";

async function readErrorMessage(response: Response, fallback: string) {
  const text = await response.text();
  let structuredMessage: string | undefined;
  try {
    const payload = JSON.parse(text) as { error?: { code?: string; message?: string } };
    structuredMessage = payload.error?.message || payload.error?.code;
  } catch {
    // Fall through to the generic response below when the body is not JSON.
  }
  return structuredMessage || text || fallback;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `请求失败：${response.status}`));
  }

  return response.json() as Promise<T>;
}

function parseSseEvent(frame: string): RunStreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) return null;
  return JSON.parse(data) as RunStreamEvent;
}

export async function loadBootstrap() {
  return parseJson<BootstrapPayload>(await fetch("/api/providers"));
}

export async function createRun(request: RunRequest) {
  return parseJson<RunResult>(
    await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    })
  );
}

export async function loadRunHistory() {
  return parseJson<RunHistoryPayload>(await fetch("/api/runs/history"));
}

export async function loadRunHistoryDetail(runId: string) {
  return parseJson<RunHistoryDetailPayload>(await fetch(`/api/runs/history/${encodeURIComponent(runId)}`));
}

export async function previewRoute(request: Partial<RunRequest>) {
  return parseJson<RoutePreviewPayload>(
    await fetch("/api/routing/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    })
  );
}

export async function streamRun(
  request: RunRequest,
  onEvent: (event: RunStreamEvent) => void,
  signal?: AbortSignal
) {
  const response = await fetch("/api/runs/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `流式请求失败：${response.status}`));
  }

  if (!response.body) {
    throw new Error("浏览器不支持流式响应");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalRun: RunResult | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      }

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(frame);
        if (event) {
          onEvent(event);
          if (event.type === "run_done") finalRun = event.run;
          if (event.type === "error") throw new Error(event.message);
        }
        boundary = buffer.indexOf("\n\n");
      }

      if (done) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      if (event) {
        onEvent(event);
        if (event.type === "run_done") finalRun = event.run;
        if (event.type === "error") throw new Error(event.message);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!finalRun) {
    throw new Error("流式运行没有返回最终结果");
  }

  return finalRun;
}

export async function loadWorkspaces() {
  return parseJson<WorkspaceBootstrapPayload>(await fetch("/api/workspaces"));
}

export async function registerWorkspace(root: string, name?: string) {
  return parseJson<{ workspace: WorkspaceBootstrapPayload["workspaces"][number] }>(
    await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root,
        ...(name ? { name } : {})
      })
    })
  );
}

export async function loadWorkspaceTree(workspaceId: string, path = ".", depth = 2) {
  const query = new URLSearchParams({ path, depth: String(depth) });
  return parseJson<WorkspaceTreePayload>(await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree?${query}`));
}

export async function readWorkspaceFile(workspaceId: string, path: string) {
  const query = new URLSearchParams({ path });
  return parseJson<WorkspaceFilePayload>(await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?${query}`));
}

export async function searchWorkspace(workspaceId: string, queryText: string, limit = 20) {
  const query = new URLSearchParams({ query: queryText, limit: String(limit) });
  return parseJson<WorkspaceSearchPayload>(await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/search?${query}`));
}

export async function previewWorkspacePatch(workspaceId: string, path: string, newContent: string) {
  return parseJson<WorkspacePatchPreviewPayload>(
    await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/patches/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, newContent })
    })
  );
}

export async function applyWorkspacePatch(workspaceId: string, path: string, newContent: string, expectedHash: string) {
  return parseJson<WorkspacePatchApplyPayload>(
    await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/patches/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, newContent, expectedHash })
    })
  );
}

export async function previewWorkspaceShell(workspaceId: string, command: string, cwd = ".") {
  return parseJson<WorkspaceShellPreviewPayload>(
    await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/shell/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, cwd })
    })
  );
}

export async function runWorkspaceShell(workspaceId: string, command: string, cwd = ".", timeoutMs = 5000) {
  return parseJson<WorkspaceShellRunPayload>(
    await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/shell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, cwd, timeoutMs })
    })
  );
}

export async function loadWorkspaceAudit(workspaceId: string) {
  return parseJson<WorkspaceAuditPayload>(await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/audit`));
}
