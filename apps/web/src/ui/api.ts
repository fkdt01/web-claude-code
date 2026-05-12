import type { RunRequest, RunResult } from "@webcode/core";
import type { BootstrapPayload } from "./types";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
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
