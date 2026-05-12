import type { RunRequest, RunResult } from "@webcode/core";
import type {
  BootstrapPayload,
  WorkspaceAuditPayload,
  WorkspaceBootstrapPayload,
  WorkspaceFilePayload,
  WorkspaceSearchPayload,
  WorkspaceTreePayload
} from "./types";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    let structuredMessage: string | undefined;
    try {
      const payload = JSON.parse(text) as { error?: { code?: string; message?: string } };
      structuredMessage = payload.error?.message || payload.error?.code;
    } catch {
      // Fall through to the generic response below when the body is not JSON.
    }
    throw new Error(structuredMessage || text || `请求失败：${response.status}`);
  }

  return response.json() as Promise<T>;
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

export async function loadWorkspaceAudit(workspaceId: string) {
  return parseJson<WorkspaceAuditPayload>(await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/audit`));
}
