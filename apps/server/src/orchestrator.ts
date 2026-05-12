import type {
  AuditEvent,
  ModelDescriptor,
  ModelEvent,
  ModelRunResult,
  OrchestrationMode,
  ProviderAdapter,
  RunRequest,
  RunResult,
  RunStreamEvent,
  TokenUsage,
  UnifiedChatRequest
} from "@webcode/core";
import { defaultToolSpecs, modelKey } from "@webcode/core";

type ModelEntry = {
  key: string;
  model: ModelDescriptor;
  provider: ProviderAdapter;
};

type StreamRunOptions = {
  signal?: AbortSignal;
};

const systemPrompt = `You are a web coding agent. Work from explicit user intent, prefer reviewable patches, and surface risky tool usage before execution.`;

function audit(label: string, detail: string, level: AuditEvent["level"] = "info"): AuditEvent {
  return {
    id: crypto.randomUUID(),
    label,
    detail,
    level,
    at: new Date().toISOString()
  };
}

function listModels(providers: ProviderAdapter[]): ModelEntry[] {
  return providers.flatMap((provider) =>
    provider.models().map((model) => ({
      key: modelKey(model),
      model,
      provider
    }))
  );
}

function selectModels(request: RunRequest, providers: ProviderAdapter[]): ModelEntry[] {
  const all = listModels(providers);
  const selected = request.selectedModels.length
    ? all.filter((entry) => request.selectedModels.includes(entry.key))
    : all.filter((entry) => entry.model.provider === "mock");

  return selected.length ? selected : all.filter((entry) => entry.model.provider === "mock");
}

function createChatRequest(
  entry: ModelEntry,
  request: RunRequest,
  runId: string,
  signal?: AbortSignal
): UnifiedChatRequest {
  return {
    runId,
    model: entry.model,
    maxOutputTokens: request.maxOutputTokens ?? 1200,
    temperature: 0.2,
    ...(signal ? { signal } : {}),
    tools: defaultToolSpecs,
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "text", text: request.prompt }]
      }
    ]
  };
}

async function collectModel(entry: ModelEntry, request: RunRequest, runId: string): Promise<ModelRunResult> {
  const chatRequest = createChatRequest(entry, request, runId);

  let text = "";
  let usage: TokenUsage | undefined;

  try {
    for await (const event of entry.provider.chat(chatRequest)) {
      if (event.type === "message_delta") text += event.text;
      if (event.type === "usage") usage = event.usage;
      if (event.type === "error") {
        return {
          modelKey: entry.key,
          provider: entry.model.provider,
          model: entry.model.id,
          role: entry.model.role,
          ok: false,
          text,
          error: event.message
        };
      }
    }

    return {
      modelKey: entry.key,
      provider: entry.model.provider,
      model: entry.model.id,
      role: entry.model.role,
      ok: true,
      text,
      ...(usage ? { usage } : {})
    };
  } catch (error) {
    return {
      modelKey: entry.key,
      provider: entry.model.provider,
      model: entry.model.id,
      role: entry.model.role,
      ok: false,
      text,
      error: error instanceof Error ? error.message : "Unknown provider error"
    };
  }
}

function summarizeCommittee(results: ModelRunResult[]) {
  const successful = results.filter((result) => result.ok && result.text.trim());
  if (!successful.length) return "所有模型都没有返回可用结果。请检查 provider 配置或先使用 mock provider。";

  return [
    "委员会结论：",
    ...successful.map((result) => `- ${result.provider}/${result.model} (${result.role})：${result.text.trim()}`),
    "",
    "建议执行路径：先采用 planner 的任务拆解，交给 coder 生成可审查 patch，再用 reviewer 进行风险检查。"
  ].join("\n");
}

function summarizeSpecialists(results: ModelRunResult[]) {
  const byRole = new Map<ModelRunResult["role"], ModelRunResult[]>();
  for (const result of results) {
    if (!result.ok) continue;
    byRole.set(result.role, [...(byRole.get(result.role) ?? []), result]);
  }

  return [
    "专家组输出：",
    `规划：${byRole.get("planner")?.[0]?.text ?? "尚未选择 planner 模型。"}`,
    `实现：${byRole.get("coder")?.[0]?.text ?? "尚未选择 coder 模型。"}`,
    `评审：${byRole.get("reviewer")?.[0]?.text ?? "尚未选择 reviewer 模型。"}`,
    `补充：${byRole.get("generalist")?.[0]?.text ?? "暂无 generalist 补充。"}`
  ].join("\n\n");
}

function finalForMode(mode: OrchestrationMode, results: ModelRunResult[]) {
  if (mode === "single") {
    return results.find((result) => result.ok)?.text ?? results[0]?.error ?? "模型未返回结果。";
  }

  if (mode === "race") {
    return results.find((result) => result.ok)?.text ?? results[0]?.error ?? "没有模型赢得竞速。";
  }

  if (mode === "specialist") return summarizeSpecialists(results);

  return summarizeCommittee(results);
}

async function runRace(entries: ModelEntry[], request: RunRequest, runId: string) {
  const settled = await Promise.race(entries.map((entry) => collectModel(entry, request, runId)));
  return [settled];
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return true;
    }
    this.values.push(value);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

function cancelledModelResult(entry: ModelEntry, text: string): ModelRunResult {
  return {
    modelKey: entry.key,
    provider: entry.model.provider,
    model: entry.model.id,
    role: entry.model.role,
    ok: false,
    text,
    error: "Run cancelled"
  };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function collectModelStream(
  entry: ModelEntry,
  request: RunRequest,
  runId: string,
  queue: AsyncQueue<RunStreamEvent>,
  signal?: AbortSignal
): Promise<ModelRunResult> {
  const chatRequest = createChatRequest(entry, request, runId, signal);
  const startedAt = new Date().toISOString();
  let text = "";
  let usage: TokenUsage | undefined;

  if (signal?.aborted) return cancelledModelResult(entry, text);

  queue.push({
    type: "model_started",
    runId,
    at: startedAt,
    modelKey: entry.key,
    provider: entry.model.provider,
    model: entry.model.id,
    role: entry.model.role
  });

  try {
    for await (const event of entry.provider.chat(chatRequest)) {
      if (signal?.aborted) return cancelledModelResult(entry, text);
      if (event.type === "message_delta") text += event.text;
      if (event.type === "usage") usage = event.usage;
      queue.push({
        type: "model_event",
        runId,
        at: new Date().toISOString(),
        modelKey: entry.key,
        event
      });
      if (signal?.aborted) return cancelledModelResult(entry, text);
      if (event.type === "error") {
        const result: ModelRunResult = {
          modelKey: entry.key,
          provider: entry.model.provider,
          model: entry.model.id,
          role: entry.model.role,
          ok: false,
          text,
          error: event.message
        };
        queue.push({ type: "model_done", runId, at: new Date().toISOString(), result });
        return result;
      }
    }

    if (signal?.aborted) return cancelledModelResult(entry, text);

    const result: ModelRunResult = {
      modelKey: entry.key,
      provider: entry.model.provider,
      model: entry.model.id,
      role: entry.model.role,
      ok: true,
      text,
      ...(usage ? { usage } : {})
    };
    queue.push({ type: "model_done", runId, at: new Date().toISOString(), result });
    return result;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return cancelledModelResult(entry, text);
    const result: ModelRunResult = {
      modelKey: entry.key,
      provider: entry.model.provider,
      model: entry.model.id,
      role: entry.model.role,
      ok: false,
      text,
      error: error instanceof Error ? error.message : "Unknown provider error"
    };
    queue.push({ type: "model_done", runId, at: new Date().toISOString(), result });
    return result;
  }
}

export async function orchestrateRun(request: RunRequest, providers: ProviderAdapter[]): Promise<RunResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const selected = selectModels(request, providers).filter((entry) => entry.model.available);
  const fallbackSelected = selected.length ? selected : selectModels({ ...request, selectedModels: [] }, providers);
  const entries = request.mode === "single" ? fallbackSelected.slice(0, 1) : fallbackSelected;

  const events: AuditEvent[] = [
    audit("任务已创建", `编排模式：${request.mode}，模型数量：${entries.length}。`),
    audit("工具策略已加载", `${defaultToolSpecs.length} 个工具规格已接入策略检查。`)
  ];

  const responses =
    request.mode === "race"
      ? await runRace(entries, request, runId)
      : await Promise.all(entries.map((entry) => collectModel(entry, request, runId)));

  const blocked = responses.filter((response) => !response.ok);
  for (const response of blocked) {
    events.push(audit("模型接口错误", `${response.provider}/${response.model}: ${response.error}`, "warning"));
  }

  return {
    id: runId,
    mode: request.mode,
    startedAt,
    completedAt: new Date().toISOString(),
    selectedModels: entries.map((entry) => entry.key),
    final: finalForMode(request.mode, responses),
    responses,
    audit: events
  };
}

export async function* streamRun(
  request: RunRequest,
  providers: ProviderAdapter[],
  options: StreamRunOptions = {}
): AsyncIterable<RunStreamEvent> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const selected = selectModels(request, providers).filter((entry) => entry.model.available);
  const fallbackSelected = selected.length ? selected : selectModels({ ...request, selectedModels: [] }, providers);
  const entries = request.mode === "single" ? fallbackSelected.slice(0, 1) : fallbackSelected;
  const events: AuditEvent[] = [
    audit("任务已创建", `编排模式：${request.mode}，模型数量：${entries.length}。`),
    audit("工具策略已加载", `${defaultToolSpecs.length} 个工具规格已接入策略检查。`)
  ];
  const queue = new AsyncQueue<RunStreamEvent>();
  const results: ModelRunResult[] = [];
  const signal = options.signal;

  if (signal?.aborted) return;

  yield {
    type: "run_started",
    runId,
    at: startedAt,
    mode: request.mode,
    selectedModels: entries.map((entry) => entry.key),
    audit: events
  };

  const closeQueue = () => queue.close();
  signal?.addEventListener("abort", closeQueue, { once: true });

  void Promise.all(
    entries.map(async (entry) => {
      const result = await collectModelStream(entry, request, runId, queue, signal);
      results.push(result);
    })
  )
    .then(() => {
      if (signal?.aborted) {
        queue.close();
        return;
      }
      const blocked = results.filter((response) => !response.ok);
      for (const response of blocked) {
        events.push(audit("模型接口错误", `${response.provider}/${response.model}: ${response.error}`, "warning"));
      }
      const run: RunResult = {
        id: runId,
        mode: request.mode,
        startedAt,
        completedAt: new Date().toISOString(),
        selectedModels: entries.map((entry) => entry.key),
        final: finalForMode(request.mode, results),
        responses: results,
        audit: events
      };
      queue.push({ type: "run_done", at: run.completedAt, run });
      queue.close();
    })
    .catch((error) => {
      queue.push({
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : "Unknown stream error"
      });
      queue.close();
    });

  try {
    for await (const event of queue) {
      if (signal?.aborted) break;
      yield event;
    }
  } finally {
    signal?.removeEventListener("abort", closeQueue);
    queue.close();
  }
}

export function providerPayload(providers: ProviderAdapter[]) {
  return providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    models: provider.models()
  }));
}

export function flattenEvents(events: ModelEvent[]) {
  return events.map((event) => event.type);
}
