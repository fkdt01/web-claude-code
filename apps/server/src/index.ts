import cors from "@fastify/cors";
import Fastify from "fastify";
import type { RunRequest } from "@webcode/core";
import { classifyShellCommand, defaultToolSpecs } from "@webcode/core";
import { orchestrateRun, providerPayload } from "./orchestrator.js";
import { createProviderRegistry } from "./providers.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const providers = createProviderRegistry();

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true
});

app.get("/api/health", async () => ({
  ok: true,
  at: new Date().toISOString()
}));

app.get("/api/providers", async () => ({
  providers: providerPayload(providers),
  modes: ["single", "race", "committee", "specialist"],
  tools: defaultToolSpecs
}));

app.post<{ Body: RunRequest }>("/api/runs", async (request, reply) => {
  if (!request.body?.prompt?.trim()) {
    return reply.code(400).send({ error: "prompt is required" });
  }

  const result = await orchestrateRun(
    {
      prompt: request.body.prompt,
      mode: request.body.mode ?? "committee",
      selectedModels: request.body.selectedModels ?? [],
      ...(request.body.workspaceId ? { workspaceId: request.body.workspaceId } : {}),
      ...(request.body.maxOutputTokens ? { maxOutputTokens: request.body.maxOutputTokens } : {})
    },
    providers
  );

  return result;
});

app.post<{ Body: { command?: string } }>("/api/policy/shell", async (request, reply) => {
  if (!request.body?.command?.trim()) {
    return reply.code(400).send({ error: "command is required" });
  }

  return classifyShellCommand(request.body.command);
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
