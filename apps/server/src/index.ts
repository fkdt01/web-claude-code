import cors from "@fastify/cors";
import Fastify from "fastify";
import type { RunRequest } from "@webcode/core";
import { classifyShellCommand, defaultToolSpecs } from "@webcode/core";
import { orchestrateRun, providerPayload } from "./orchestrator.js";
import { createProviderRegistry } from "./providers.js";
import { createWorkspaceService, WorkspaceError } from "./workspaces.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const patchPreviewBodyLimit = 1024 * 1024;
const providers = createProviderRegistry();
const workspaceService = await createWorkspaceService();

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? true
});

type WorkspaceParams = {
  workspaceId: string;
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
