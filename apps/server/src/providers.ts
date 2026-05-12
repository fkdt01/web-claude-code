import type {
  ModelDescriptor,
  ModelCost,
  ModelEvent,
  ProviderAdapter,
  ProviderId,
  TokenUsage,
  UnifiedChatRequest,
  UnifiedMessage
} from "@webcode/core";
import { modelKey, textFromContent } from "@webcode/core";

const DEFAULT_CAPABILITIES = {
  streaming: false,
  toolCalls: false,
  vision: false,
  jsonMode: true,
  contextWindow: 128_000
};

const MOCK_COST: ModelCost = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  currency: "USD"
};

function parseCostRate(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function costFromEnv(env: Record<string, string | undefined>, prefix: string): ModelCost | undefined {
  const inputPerMillion = parseCostRate(env[`${prefix}_INPUT_COST_PER_MILLION`]);
  const outputPerMillion = parseCostRate(env[`${prefix}_OUTPUT_COST_PER_MILLION`]);
  if (inputPerMillion === undefined && outputPerMillion === undefined) return undefined;

  return {
    ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
    ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
    currency: "USD"
  };
}

function estimateCostUsd(usage: Pick<TokenUsage, "inputTokens" | "outputTokens">, cost: ModelCost | undefined) {
  if (!cost || (cost.currency && cost.currency !== "USD")) return undefined;
  if (cost.inputPerMillion === undefined && cost.outputPerMillion === undefined) return undefined;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return undefined;
  if (cost.inputPerMillion !== undefined && !Number.isFinite(cost.inputPerMillion)) return undefined;
  if (cost.outputPerMillion !== undefined && !Number.isFinite(cost.outputPerMillion)) return undefined;

  const estimated =
    (usage.inputTokens * (cost.inputPerMillion ?? 0)) / 1_000_000 +
    (usage.outputTokens * (cost.outputPerMillion ?? 0)) / 1_000_000;
  return Number.isFinite(estimated) ? Number(estimated.toFixed(8)) : undefined;
}

function usageWithCost(usage: TokenUsage, cost: ModelCost | undefined): TokenUsage {
  const estimatedCostUsd = estimateCostUsd(usage, cost);
  return estimatedCostUsd === undefined ? usage : { ...usage, estimatedCostUsd };
}

const nowUsage = (text: string, cost: ModelCost | undefined) => {
  const roughOutputTokens = Math.max(1, Math.ceil(text.length / 4));
  return usageWithCost({
    inputTokens: 0,
    outputTokens: roughOutputTokens,
    totalTokens: roughOutputTokens
  }, cost);
};

function latestUserText(messages: UnifiedMessage[]) {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return latest ? textFromContent(latest.content) : "";
}

async function* emitText(request: UnifiedChatRequest, text: string): AsyncIterable<ModelEvent> {
  const key = modelKey(request.model);
  yield { type: "message_delta", runId: request.runId, modelKey: key, text };
  yield { type: "usage", runId: request.runId, modelKey: key, usage: nowUsage(text, request.model.cost) };
  yield { type: "done", runId: request.runId, modelKey: key };
}

class MockProvider implements ProviderAdapter {
  id: ProviderId = "mock";
  displayName = "模拟模型组";

  models(): ModelDescriptor[] {
    return [
      {
        id: "planner",
        provider: this.id,
        label: "Mock Planner",
        role: "planner",
        available: true,
        cost: MOCK_COST,
        capabilities: { ...DEFAULT_CAPABILITIES, streaming: true, contextWindow: 32_000 }
      },
      {
        id: "coder",
        provider: this.id,
        label: "Mock Coder",
        role: "coder",
        available: true,
        cost: MOCK_COST,
        capabilities: { ...DEFAULT_CAPABILITIES, streaming: true, toolCalls: true, contextWindow: 32_000 }
      },
      {
        id: "reviewer",
        provider: this.id,
        label: "Mock Reviewer",
        role: "reviewer",
        available: true,
        cost: MOCK_COST,
        capabilities: { ...DEFAULT_CAPABILITIES, streaming: true, contextWindow: 32_000 }
      }
    ];
  }

  chat(request: UnifiedChatRequest) {
    const prompt = latestUserText(request.messages);
    const role = request.model.role;
    const textByRole = {
      planner: `规划结论：先把需求拆成工作台、模型网关、工具运行时、安全策略和审计五层。当前任务「${prompt}」适合先做 Web MVP，再逐步接入真实工作区。`,
      coder: `实现建议：用统一协议隔离 Provider 差异，后端只暴露 run API，前端只关心模型、策略和结果。写文件与执行命令应通过可审计工具队列，而不是让模型直连 shell。`,
      reviewer: `评审意见：高风险点是密钥、shell、跨目录读写和成本失控。默认使用 mock 模型、只读工具和 reviewable patch，是一个更稳的起步姿势。`,
      generalist: `综合意见：保持 provider adapter、orchestrator、tool runtime 三个边界清晰，后续才能安全地加入 Claude、OpenAI、Gemini、OpenRouter 和本地模型。`
    } satisfies Record<typeof role, string>;

    return emitText(request, textByRole[role]);
  }
}

type OpenAICompatibleOptions = {
  id: ProviderId;
  displayName: string;
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  role?: ModelDescriptor["role"];
  cost?: ModelCost | undefined;
};

class OpenAICompatibleProvider implements ProviderAdapter {
  id: ProviderId;
  displayName: string;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private role: ModelDescriptor["role"];
  private cost: ModelCost | undefined;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.role = options.role ?? "generalist";
    this.cost = options.cost;
  }

  models(): ModelDescriptor[] {
    return [
      {
        id: this.model,
        provider: this.id,
        label: this.model,
        role: this.role,
        available: Boolean(this.apiKey),
        ...(this.cost ? { cost: this.cost } : {}),
        capabilities: { ...DEFAULT_CAPABILITIES, toolCalls: true, contextWindow: 128_000 }
      }
    ];
  }

  async *chat(request: UnifiedChatRequest): AsyncIterable<ModelEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        runId: request.runId,
        modelKey: modelKey(request.model),
        message: `${this.displayName} is not configured.`,
        retryable: false
      };
      return;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      ...(request.signal ? { signal: request.signal } : {}),
      body: JSON.stringify({
        model: request.model.id,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens ?? 1200,
        messages: request.messages.map((message) => ({
          role: message.role === "tool" ? "user" : message.role,
          content: textFromContent(message.content)
        }))
      })
    });

    if (!response.ok) {
      yield {
        type: "error",
        runId: request.runId,
        modelKey: modelKey(request.model),
        message: `${this.displayName} returned ${response.status}: ${await response.text()}`,
        retryable: response.status >= 500
      };
      return;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    yield { type: "message_delta", runId: request.runId, modelKey: modelKey(request.model), text };
    if (json.usage) {
      yield {
        type: "usage",
        runId: request.runId,
        modelKey: modelKey(request.model),
        usage: usageWithCost({
          inputTokens: json.usage.prompt_tokens ?? 0,
          outputTokens: json.usage.completion_tokens ?? 0,
          totalTokens: json.usage.total_tokens ?? 0
        }, request.model.cost)
      };
    }
    yield { type: "done", runId: request.runId, modelKey: modelKey(request.model) };
  }
}

class AnthropicProvider implements ProviderAdapter {
  id: ProviderId = "anthropic";
  displayName = "Anthropic";
  private apiKey: string | undefined;
  private model: string;
  private cost: ModelCost | undefined;

  constructor(apiKey: string | undefined, model: string, cost?: ModelCost) {
    this.apiKey = apiKey;
    this.model = model;
    this.cost = cost;
  }

  models(): ModelDescriptor[] {
    return [
      {
        id: this.model,
        provider: this.id,
        label: this.model,
        role: "generalist",
        available: Boolean(this.apiKey),
        ...(this.cost ? { cost: this.cost } : {}),
        capabilities: { ...DEFAULT_CAPABILITIES, toolCalls: true, contextWindow: 200_000 }
      }
    ];
  }

  async *chat(request: UnifiedChatRequest): AsyncIterable<ModelEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        runId: request.runId,
        modelKey: modelKey(request.model),
        message: "Anthropic is not configured.",
        retryable: false
      };
      return;
    }

    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => textFromContent(message.content))
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: textFromContent(message.content)
      }));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      ...(request.signal ? { signal: request.signal } : {}),
      body: JSON.stringify({
        model: request.model.id,
        max_tokens: request.maxOutputTokens ?? 1200,
        temperature: request.temperature ?? 0.2,
        system,
        messages
      })
    });

    if (!response.ok) {
      yield {
        type: "error",
        runId: request.runId,
        modelKey: modelKey(request.model),
        message: `Anthropic returned ${response.status}: ${await response.text()}`,
        retryable: response.status >= 500
      };
      return;
    }

    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = json.content?.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("") ?? "";
    yield { type: "message_delta", runId: request.runId, modelKey: modelKey(request.model), text };
    if (json.usage) {
      yield {
        type: "usage",
        runId: request.runId,
        modelKey: modelKey(request.model),
        usage: usageWithCost({
          inputTokens: json.usage.input_tokens ?? 0,
          outputTokens: json.usage.output_tokens ?? 0,
          totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0)
        }, request.model.cost)
      };
    }
    yield { type: "done", runId: request.runId, modelKey: modelKey(request.model) };
  }
}

class GeminiProvider implements ProviderAdapter {
  id: ProviderId = "gemini";
  displayName = "Gemini";
  private apiKey: string | undefined;
  private model: string;
  private cost: ModelCost | undefined;

  constructor(apiKey: string | undefined, model: string, cost?: ModelCost) {
    this.apiKey = apiKey;
    this.model = model;
    this.cost = cost;
  }

  models(): ModelDescriptor[] {
    return [
      {
        id: this.model,
        provider: this.id,
        label: this.model,
        role: "generalist",
        available: Boolean(this.apiKey),
        ...(this.cost ? { cost: this.cost } : {}),
        capabilities: { ...DEFAULT_CAPABILITIES, vision: true, contextWindow: 1_000_000 }
      }
    ];
  }

  async *chat(request: UnifiedChatRequest): AsyncIterable<ModelEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        runId: request.runId,
        modelKey: modelKey(request.model),
        message: "Gemini is not configured.",
        retryable: false
      };
      return;
    }

    const prompt = request.messages.map((message) => textFromContent(message.content)).join("\n\n");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      request.model.id
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(request.signal ? { signal: request.signal } : {}),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.2,
          maxOutputTokens: request.maxOutputTokens ?? 1200
        }
      })
    });

    if (!response.ok) {
      yield {
        type: "error",
        runId: request.runId,
        modelKey: modelKey(request.model),
        message: `Gemini returned ${response.status}: ${await response.text()}`,
        retryable: response.status >= 500
      };
      return;
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    yield { type: "message_delta", runId: request.runId, modelKey: modelKey(request.model), text };
    if (json.usageMetadata) {
      yield {
        type: "usage",
        runId: request.runId,
        modelKey: modelKey(request.model),
        usage: usageWithCost({
          inputTokens: json.usageMetadata.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: json.usageMetadata.totalTokenCount ?? 0
        }, request.model.cost)
      };
    }
    yield { type: "done", runId: request.runId, modelKey: modelKey(request.model) };
  }
}

export function createProviderRegistry(env = process.env): ProviderAdapter[] {
  return [
    new MockProvider(),
    new AnthropicProvider(
      env.ANTHROPIC_API_KEY,
      env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      costFromEnv(env, "ANTHROPIC")
    ),
    new OpenAICompatibleProvider({
      id: "openai",
      displayName: "OpenAI",
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: env.OPENAI_MODEL ?? "gpt-5.4-mini",
      role: "coder",
      cost: costFromEnv(env, "OPENAI")
    }),
    new OpenAICompatibleProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: "https://openrouter.ai/api/v1",
      model: env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
      role: "generalist",
      cost: costFromEnv(env, "OPENROUTER")
    }),
    new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL ?? "gemini-2.5-pro", costFromEnv(env, "GEMINI"))
  ];
}
