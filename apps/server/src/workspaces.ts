import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  WorkspaceAuditEvent,
  WorkspaceDescriptor,
  WorkspaceDiffLine,
  WorkspaceFileRead,
  WorkspacePatchApplyResult,
  WorkspacePatchPreview,
  WorkspaceRunContext,
  WorkspaceShellPreflight,
  WorkspaceShellRunResult,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
  WorkspaceTreeEntry
} from "@webcode/core";
import { classifyShellCommand } from "@webcode/core";

const DEFAULT_EXCLUDED_NAMES = new Set([".git", "node_modules", "dist", ".logs", ".vite"]);
const SENSITIVE_FILE_NAMES = new Set([".env", ".env.local", ".env.production", ".env.development"]);
const MAX_READ_BYTES = 256 * 1024;
const MAX_PATCH_PREVIEW_BYTES = MAX_READ_BYTES;
const MAX_PATCH_APPLY_BYTES = MAX_READ_BYTES;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_TREE_DEPTH = 6;
const MAX_TREE_ENTRIES = 600;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 2_000;
const MAX_QUERY_LENGTH = 200;
const MAX_DIFF_LINES = 800;
const MAX_CONTEXT_TREE_LINES = 80;
const CONTEXT_TREE_DEPTH = 2;
const DIFF_CONTEXT_LINES = 3;
const MAX_SHELL_COMMAND_LENGTH = 300;
const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_SHELL_TIMEOUT_MS = 5_000;
const MAX_SHELL_TIMEOUT_MS = 15_000;
const SHELL_CONTROL_PATTERN = /[\n\r|&;<>()`$]/;
const SECRET_VALUE_PATTERN = /((?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*)[^\s'",;]+/gi;
const BEARER_TOKEN_PATTERN = /(bearer\s+)[a-z0-9._-]+/gi;
const OPENAI_KEY_PATTERN = /sk-[a-z0-9_-]+/gi;
const TRUSTED_EXECUTABLE_DIRS = ["/usr/bin", "/bin"];
const TRUSTED_EXECUTABLES: Record<string, string[]> = {
  ls: ["/usr/bin/ls", "/bin/ls"],
  pwd: ["/usr/bin/pwd", "/bin/pwd"]
};
const SHELL_COMMAND_HINTS = [
  {
    name: "pwd",
    usage: "pwd",
    description: "显示当前工作目录。"
  },
  {
    name: "ls",
    usage: "ls [-la|-l|-a|-h]",
    description: "列出当前目录，允许最多 5 个只读选项。"
  }
];

type WorkspaceRecord = WorkspaceDescriptor & {
  audit: WorkspaceAuditEvent[];
};

export class WorkspaceError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type WorkspaceServiceOptions = {
  allowedRoots: string[];
};

const normalizeForCompare = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isInsidePath = (root: string, target: string) => {
  const relative = path.relative(normalizeForCompare(root), normalizeForCompare(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const toPortableRelativePath = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative ? relative.split(path.sep).join("/") : ".";
};

const safeInputTarget = (input: string) => {
  if (path.isAbsolute(input)) return "[absolute-path]";
  return input || ".";
};

const isPathLikeInputSafe = (input: string) => {
  if (input.includes("\0")) return false;
  if (path.isAbsolute(input)) return false;
  return true;
};

const clampInteger = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(value)));
const contentHash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const maskSensitiveText = (value: string) =>
  value
    .replace(SECRET_VALUE_PATTERN, "$1[redacted]")
    .replace(BEARER_TOKEN_PATTERN, "$1[redacted]")
    .replace(OPENAI_KEY_PATTERN, "[redacted]");

function executableName(input: string) {
  return path.basename(input).toLowerCase().replace(/\.exe$/i, "");
}

function isSimpleOption(input: string) {
  return /^-{1,2}[a-zA-Z0-9][a-zA-Z0-9=._/-]*$/.test(input) && !input.includes("..");
}

function parseCommand(command: string) {
  if (SHELL_CONTROL_PATTERN.test(command)) {
    throw new WorkspaceError("shell_control_operator_denied", "Shell control operators are not allowed.", 403);
  }

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (!char) continue;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new WorkspaceError("shell_quote_unclosed", "Shell command contains an unclosed quote.", 400);
  }
  if (current) tokens.push(current);
  if (!tokens.length) {
    throw new WorkspaceError("shell_command_required", "Shell command is required.");
  }
  if (tokens[0]?.includes("/") || tokens[0]?.includes("\\")) {
    throw new WorkspaceError("shell_executable_path_denied", "Shell executable paths are not allowed.", 403);
  }

  return tokens;
}

function validateReadOnlyCommand(tokens: string[]) {
  const executable = executableName(tokens[0] ?? "");
  const args = tokens.slice(1);

  if (executable === "pwd") return args.length === 0;

  if (executable === "ls") {
    return args.length <= 5 && args.every((arg) => arg.startsWith("-") && isSimpleOption(arg) && !/[R]/.test(arg));
  }

  return false;
}

async function resolveTrustedExecutable(input: string) {
  const executable = executableName(input);
  const candidates = TRUSTED_EXECUTABLES[executable] ?? [];
  for (const candidate of candidates) {
    try {
      const realPath = await fs.realpath(candidate);
      if (!TRUSTED_EXECUTABLE_DIRS.includes(path.dirname(realPath))) continue;
      await fs.access(realPath, fsConstants.X_OK);
      return realPath;
    } catch {
      // Try the next trusted system path.
    }
  }

  throw new WorkspaceError("shell_executable_unavailable", "Allowlisted executable is unavailable on this Linux backend.", 501);
}

function shellEnvironment() {
  const env: NodeJS.ProcessEnv = {
    PATH: TRUSTED_EXECUTABLE_DIRS.join(":"),
    CI: "1",
    NO_COLOR: "1",
    GIT_PAGER: ""
  };
  return env;
}

function shellLimits() {
  return {
    commandLengthMax: MAX_SHELL_COMMAND_LENGTH,
    timeoutMsMax: MAX_SHELL_TIMEOUT_MS,
    outputBytesMax: MAX_SHELL_OUTPUT_BYTES
  };
}

function appendLimitedOutput(current: string, chunk: Buffer, state: { truncated: boolean }) {
  if (Buffer.byteLength(current, "utf8") >= MAX_SHELL_OUTPUT_BYTES) {
    state.truncated = true;
    return current;
  }

  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_SHELL_OUTPUT_BYTES) return next;

  state.truncated = true;
  return next.slice(0, MAX_SHELL_OUTPUT_BYTES);
}

async function executeCommand(executablePath: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<Omit<WorkspaceShellRunResult, "workspaceId" | "command" | "cwd" | "startedAt" | "completedAt" | "policy">>(
    (resolve) => {
      const outputState = { truncated: false };
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = spawn(executablePath, args, {
        cwd,
        env: shellEnvironment(),
        shell: false,
        windowsHide: true
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendLimitedOutput(stdout, chunk, outputState);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendLimitedOutput(stderr, chunk, outputState);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: null,
          timedOut,
          truncated: outputState.truncated,
          stdout: maskSensitiveText(stdout),
          stderr: maskSensitiveText(stderr || error.message)
        });
      });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          ...(signal ? { signal } : {}),
          timedOut,
          truncated: outputState.truncated,
          stdout: maskSensitiveText(stdout),
          stderr: maskSensitiveText(stderr)
        });
      });
    }
  );
}

async function realDirectory(input: string) {
  const absolute = path.resolve(input);
  const real = await fs.realpath(absolute);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new WorkspaceError("workspace_not_directory", "Workspace root must be a directory.");
  }
  return real;
}

async function isBinaryFile(filePath: string) {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY);
  try {
    const stat = await handle.stat();
    const sampleSize = Math.min(Number(stat.size), 4096);
    if (!sampleSize) return false;

    const buffer = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function createDiffLines(originalContent: string, updatedContent: string) {
  if (originalContent === updatedContent) {
    return { diff: [] as WorkspaceDiffLine[], truncated: false };
  }

  const oldLines = originalContent.split(/\r?\n/);
  const newLines = updatedContent.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const diff: WorkspaceDiffLine[] = [];
  let truncated = false;
  const pushLine = (line: WorkspaceDiffLine) => {
    if (diff.length >= MAX_DIFF_LINES) {
      truncated = true;
      return;
    }
    diff.push(line);
  };

  const contextStart = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  for (let index = contextStart; index < prefix; index += 1) {
    pushLine({ type: "context", oldLine: index + 1, newLine: index + 1, content: oldLines[index] ?? "" });
  }

  for (let index = prefix; index < oldChangeEnd; index += 1) {
    pushLine({ type: "remove", oldLine: index + 1, content: oldLines[index] ?? "" });
  }

  for (let index = prefix; index < newChangeEnd; index += 1) {
    pushLine({ type: "add", newLine: index + 1, content: newLines[index] ?? "" });
  }

  for (let offset = 0; offset < Math.min(DIFF_CONTEXT_LINES, suffix); offset += 1) {
    const oldIndex = oldChangeEnd + offset;
    const newIndex = newChangeEnd + offset;
    pushLine({
      type: "context",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      content: oldLines[oldIndex] ?? ""
    });
  }

  return { diff, truncated };
}

function parseAllowedRoots(envValue: string | undefined, fallback: string) {
  if (!envValue?.trim()) return [fallback];
  return envValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findDefaultAllowedRoot(start: string) {
  let current = path.resolve(start);
  while (true) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }

    const packageJsonPath = path.join(current, "package.json");
    if (await fileExists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { workspaces?: unknown };
        if (packageJson.workspaces) return current;
      } catch {
        // Keep walking; a malformed package file should not widen the allowed root.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export async function createWorkspaceService(env = process.env) {
  const roots = parseAllowedRoots(env.WORKSPACE_ALLOWED_ROOTS, await findDefaultAllowedRoot(process.cwd()));
  const allowedRoots = await Promise.all(roots.map((root) => realDirectory(root)));
  return new WorkspaceService({ allowedRoots });
}

export class WorkspaceService {
  private allowedRoots: string[];
  private workspaces = new Map<string, WorkspaceRecord>();

  constructor(options: WorkspaceServiceOptions) {
    this.allowedRoots = options.allowedRoots;
  }

  listAllowedRoots() {
    return [...this.allowedRoots];
  }

  listWorkspaces(): WorkspaceDescriptor[] {
    return [...this.workspaces.values()].map(({ audit: _audit, ...workspace }) => workspace);
  }

  async register(rootInput: string, nameInput?: string): Promise<WorkspaceDescriptor> {
    const root = await realDirectory(rootInput);
    if (!this.allowedRoots.some((allowedRoot) => isInsidePath(allowedRoot, root))) {
      throw new WorkspaceError("workspace_root_not_allowed", "Workspace root is outside allowed roots.", 403);
    }

    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: nameInput?.trim() || path.basename(root) || "workspace",
      root,
      createdAt: new Date().toISOString(),
      audit: []
    };
    this.workspaces.set(workspace.id, workspace);
    this.audit(workspace, "register_workspace", "allowed", ".", `Registered workspace ${maskSensitiveText(workspace.name)}.`);
    const { audit: _audit, ...descriptor } = workspace;
    return descriptor;
  }

  async tree(workspaceId: string, relativePath = ".", depth = 3) {
    const workspace = this.requireWorkspace(workspaceId);
    const targetLabel = relativePath || ".";
    try {
      const directory = await this.resolveInsideWorkspace(workspace, relativePath, "directory");
      const maxDepth = clampInteger(depth, 0, MAX_TREE_DEPTH);
      const counter = { value: 0 };
      const root = await this.buildTree(workspace, directory, maxDepth, counter);
      this.audit(workspace, "file_tree", "allowed", targetLabel, `Returned ${counter.value} tree entries.`);
      return { workspace: this.describe(workspace), root };
    } catch (error) {
      this.audit(workspace, "file_tree", "denied", safeInputTarget(targetLabel), error instanceof Error ? error.message : "Unknown error.");
      throw error;
    }
  }

  async readFile(workspaceId: string, relativePath: string): Promise<WorkspaceFileRead> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      const filePath = await this.resolveInsideWorkspace(workspace, relativePath, "file");
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_READ_BYTES) {
        throw new WorkspaceError("file_too_large", `File exceeds read limit of ${MAX_READ_BYTES} bytes.`, 413);
      }
      if (await isBinaryFile(filePath)) {
        throw new WorkspaceError("binary_file_not_readable", "Binary files cannot be read as text.", 415);
      }

      const content = await fs.readFile(filePath, "utf8");
      const portablePath = toPortableRelativePath(workspace.root, filePath);
      this.audit(workspace, "read_file", "allowed", portablePath, `Read ${stat.size} bytes.`);
      return {
        workspaceId: workspace.id,
        path: portablePath,
        size: stat.size,
        content
      };
    } catch (error) {
      this.audit(workspace, "read_file", "denied", safeInputTarget(relativePath), error instanceof Error ? error.message : "Unknown error.");
      throw error;
    }
  }

  async search(workspaceId: string, query: string, limit = 50): Promise<WorkspaceSearchResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const cleanQuery = query.trim();
    if (!cleanQuery) {
      this.audit(workspace, "search_workspace", "denied", "", "Search query is required.");
      throw new WorkspaceError("query_required", "Search query is required.");
    }
    if (cleanQuery.length > MAX_QUERY_LENGTH) {
      this.audit(workspace, "search_workspace", "denied", "", "Search query is too long.");
      throw new WorkspaceError("query_too_long", `Search query cannot exceed ${MAX_QUERY_LENGTH} characters.`);
    }

    const resultLimit = clampInteger(limit, 1, MAX_SEARCH_RESULTS);
    const matches: WorkspaceSearchMatch[] = [];
    let visitedFiles = 0;
    const needle = cleanQuery.toLowerCase();

    try {
      for await (const filePath of this.walkTextCandidateFiles(workspace.root)) {
        if (matches.length >= resultLimit || visitedFiles >= MAX_SEARCH_FILES) break;
        visitedFiles += 1;
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;
        if (await isBinaryFile(filePath)) continue;

        const text = await fs.readFile(filePath, "utf8");
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line?.toLowerCase().includes(needle)) {
            matches.push({
              path: toPortableRelativePath(workspace.root, filePath),
              line: index + 1,
              preview: line.trim().slice(0, 240)
            });
            if (matches.length >= resultLimit) break;
          }
        }
      }

      this.audit(
        workspace,
        "search_workspace",
        "allowed",
        cleanQuery,
        `Returned ${matches.length} match(es) after scanning ${visitedFiles} file(s).`
      );
      return {
        workspaceId: workspace.id,
        query: cleanQuery,
        matches
      };
    } catch (error) {
      this.audit(workspace, "search_workspace", "error", cleanQuery, error instanceof Error ? error.message : "Unknown error.");
      throw error;
    }
  }

  async contextSummary(workspaceId: string): Promise<WorkspaceRunContext> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      const directory = await this.resolveInsideWorkspace(workspace, ".", "directory");
      const counter = { value: 0 };
      const root = await this.buildTree(workspace, directory, CONTEXT_TREE_DEPTH, counter);
      const lines: string[] = [];
      const truncatedByLines = this.flattenTree(root, lines);
      const truncated = truncatedByLines || counter.value >= MAX_TREE_ENTRIES;
      this.audit(
        workspace,
        "file_tree",
        "allowed",
        ".",
        `Built run context with ${lines.length} tree line(s)${truncated ? " and truncated output" : ""}.`
      );
      return {
        workspaceId: workspace.id,
        name: maskSensitiveText(workspace.name),
        treeLines: lines.map(maskSensitiveText),
        truncated
      };
    } catch (error) {
      this.audit(
        workspace,
        "file_tree",
        "denied",
        ".",
        error instanceof Error ? error.message : "Unknown error."
      );
      throw error;
    }
  }

  async previewPatch(workspaceId: string, relativePath: string, newContent: string): Promise<WorkspacePatchPreview> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      if (newContent.includes("\0")) {
        throw new WorkspaceError("patch_content_binary", "Patch preview content must be text.", 415);
      }

      const updatedSize = Buffer.byteLength(newContent, "utf8");
      if (updatedSize > MAX_PATCH_PREVIEW_BYTES) {
        throw new WorkspaceError("patch_preview_too_large", `Patch preview exceeds limit of ${MAX_PATCH_PREVIEW_BYTES} bytes.`, 413);
      }

      const filePath = await this.resolveInsideWorkspace(workspace, relativePath, "file");
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_READ_BYTES) {
        throw new WorkspaceError("file_too_large", `File exceeds read limit of ${MAX_READ_BYTES} bytes.`, 413);
      }
      if (await isBinaryFile(filePath)) {
        throw new WorkspaceError("binary_file_not_readable", "Binary files cannot be diffed as text.", 415);
      }

      const originalContent = await fs.readFile(filePath, "utf8");
      const portablePath = toPortableRelativePath(workspace.root, filePath);
      const { diff, truncated } = createDiffLines(originalContent, newContent);
      this.audit(
        workspace,
        "preview_patch",
        "allowed",
        portablePath,
        `Previewed patch with ${diff.length} diff line(s)${truncated ? " and truncated output" : ""}.`
      );
      return {
        workspaceId: workspace.id,
        path: portablePath,
        baseHash: contentHash(originalContent),
        originalSize: stat.size,
        updatedSize,
        changed: originalContent !== newContent,
        truncated,
        diff
      };
    } catch (error) {
      this.audit(workspace, "preview_patch", "denied", safeInputTarget(relativePath), error instanceof Error ? error.message : "Unknown error.");
      throw error;
    }
  }

  async applyPatch(
    workspaceId: string,
    relativePath: string,
    newContent: string,
    expectedHash: string
  ): Promise<WorkspacePatchApplyResult> {
    const workspace = this.requireWorkspace(workspaceId);
    try {
      const cleanExpectedHash = expectedHash.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(cleanExpectedHash)) {
        throw new WorkspaceError("patch_hash_invalid", "Patch apply requires a valid base hash.");
      }
      if (newContent.includes("\0")) {
        throw new WorkspaceError("patch_content_binary", "Patch apply content must be text.", 415);
      }

      const nextSize = Buffer.byteLength(newContent, "utf8");
      if (nextSize > MAX_PATCH_APPLY_BYTES) {
        throw new WorkspaceError("patch_apply_too_large", `Patch apply exceeds limit of ${MAX_PATCH_APPLY_BYTES} bytes.`, 413);
      }

      const filePath = await this.resolveInsideWorkspace(workspace, relativePath, "file");
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_READ_BYTES) {
        throw new WorkspaceError("file_too_large", `File exceeds read limit of ${MAX_READ_BYTES} bytes.`, 413);
      }
      if (await isBinaryFile(filePath)) {
        throw new WorkspaceError("binary_file_not_writable", "Binary files cannot be patched as text.", 415);
      }

      const currentContent = await fs.readFile(filePath, "utf8");
      const previousHash = contentHash(currentContent);
      const portablePath = toPortableRelativePath(workspace.root, filePath);
      if (previousHash !== cleanExpectedHash) {
        throw new WorkspaceError("patch_conflict", "File changed since preview; refresh the diff before applying.", 409);
      }

      const nextHash = contentHash(newContent);
      const changed = currentContent !== newContent;
      if (changed) {
        await fs.writeFile(filePath, newContent, "utf8");
      }

      this.audit(
        workspace,
        "apply_patch",
        "allowed",
        portablePath,
        changed ? `Applied patch; wrote ${nextSize} byte(s).` : "Skipped apply because content was unchanged."
      );
      return {
        workspaceId: workspace.id,
        path: portablePath,
        appliedAt: new Date().toISOString(),
        previousHash,
        nextHash,
        previousSize: stat.size,
        nextSize,
        changed
      };
    } catch (error) {
      this.audit(workspace, "apply_patch", "denied", safeInputTarget(relativePath), error instanceof Error ? error.message : "Unknown error.");
      throw error;
    }
  }

  async previewShell(workspaceId: string, commandInput: string, relativeCwd = "."): Promise<WorkspaceShellPreflight> {
    const workspace = this.requireWorkspace(workspaceId);
    const command = commandInput.trim();
    const target = command ? maskSensitiveText(command) : "[empty-command]";
    const policy = classifyShellCommand(command);
    let cwd = safeInputTarget(relativeCwd);

    const makePreview = (
      allowed: boolean,
      reason: string,
      code?: string,
      enabled = process.platform === "linux"
    ): WorkspaceShellPreflight => ({
      workspaceId: workspace.id,
      command: target,
      cwd,
      enabled,
      allowed,
      reason: maskSensitiveText(reason),
      ...(code ? { code } : {}),
      policy,
      commands: SHELL_COMMAND_HINTS,
      limits: shellLimits()
    });

    try {
      const realCwd = await this.resolveInsideWorkspace(workspace, relativeCwd, "directory");
      cwd = toPortableRelativePath(workspace.root, realCwd);
    } catch (error) {
      return makePreview(
        false,
        error instanceof Error ? error.message : "Workspace cwd is invalid.",
        error instanceof WorkspaceError ? error.code : "path_invalid"
      );
    }

    if (!command) {
      return makePreview(false, "Shell command is required.", "shell_command_required");
    }
    if (command.length > MAX_SHELL_COMMAND_LENGTH) {
      return makePreview(
        false,
        `Shell command cannot exceed ${MAX_SHELL_COMMAND_LENGTH} characters.`,
        "shell_command_too_long"
      );
    }
    if (policy.action !== "allow" || policy.risk !== "low") {
      return makePreview(false, policy.reason, "shell_policy_blocked");
    }

    let tokens: string[];
    try {
      tokens = parseCommand(command);
    } catch (error) {
      return makePreview(
        false,
        error instanceof Error ? error.message : "Shell command is invalid.",
        error instanceof WorkspaceError ? error.code : "shell_command_invalid"
      );
    }

    if (!validateReadOnlyCommand(tokens)) {
      return makePreview(false, "Only allowlisted read-only shell commands can run.", "shell_command_not_allowed");
    }
    if (process.platform !== "linux") {
      return makePreview(false, "Shell runner is only enabled on Linux backends.", "shell_runner_linux_required", false);
    }

    try {
      await resolveTrustedExecutable(tokens[0] ?? "");
    } catch (error) {
      return makePreview(
        false,
        error instanceof Error ? error.message : "Allowlisted executable is unavailable.",
        error instanceof WorkspaceError ? error.code : "shell_executable_unavailable"
      );
    }

    return makePreview(true, "Command matches the read-only allowlist and can run on this Linux backend.");
  }

  async runShell(
    workspaceId: string,
    commandInput: string,
    relativeCwd = ".",
    timeoutInput = DEFAULT_SHELL_TIMEOUT_MS
  ): Promise<WorkspaceShellRunResult> {
    const workspace = this.requireWorkspace(workspaceId);
    const command = commandInput.trim();
    const target = command ? maskSensitiveText(command) : "[empty-command]";
    try {
      if (process.platform !== "linux") {
        throw new WorkspaceError("shell_runner_linux_required", "Shell runner is only enabled on Linux backends.", 501);
      }
      if (!command) {
        throw new WorkspaceError("shell_command_required", "Shell command is required.");
      }
      if (command.length > MAX_SHELL_COMMAND_LENGTH) {
        throw new WorkspaceError("shell_command_too_long", `Shell command cannot exceed ${MAX_SHELL_COMMAND_LENGTH} characters.`, 413);
      }

      const policy = classifyShellCommand(command);
      if (policy.action !== "allow" || policy.risk !== "low") {
        throw new WorkspaceError("shell_policy_blocked", policy.reason, 403);
      }

      const tokens = parseCommand(command);
      if (!validateReadOnlyCommand(tokens)) {
        throw new WorkspaceError("shell_command_not_allowed", "Only allowlisted read-only shell commands can run.", 403);
      }

      const executablePath = await resolveTrustedExecutable(tokens[0] ?? "");
      const cwd = await this.resolveInsideWorkspace(workspace, relativeCwd, "directory");
      const timeoutMs = clampInteger(timeoutInput, 500, MAX_SHELL_TIMEOUT_MS);
      const startedAt = new Date().toISOString();
      const result = await executeCommand(executablePath, tokens.slice(1), cwd, timeoutMs);
      const completedAt = new Date().toISOString();
      const portableCwd = toPortableRelativePath(workspace.root, cwd);
      this.audit(
        workspace,
        "run_shell",
        result.exitCode === 0 && !result.timedOut ? "allowed" : "error",
        `${portableCwd} $ ${target}`,
        `Ran allowlisted read-only command; exit=${result.exitCode ?? "null"}${result.timedOut ? ", timed out" : ""}.`
      );

      return {
        workspaceId: workspace.id,
        command: target,
        cwd: portableCwd,
        startedAt,
        completedAt,
        policy,
        ...result
      };
    } catch (error) {
      this.audit(
        workspace,
        "run_shell",
        "denied",
        target,
        error instanceof Error ? maskSensitiveText(error.message) : "Unknown error."
      );
      throw error;
    }
  }

  auditFor(workspaceId: string): WorkspaceAuditEvent[] {
    return [...this.requireWorkspace(workspaceId).audit];
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new WorkspaceError("workspace_not_found", "Workspace was not found.", 404);
    }
    return workspace;
  }

  private describe(workspace: WorkspaceRecord): WorkspaceDescriptor {
    const { audit: _audit, ...descriptor } = workspace;
    return descriptor;
  }

  private audit(
    workspace: WorkspaceRecord,
    action: WorkspaceAuditEvent["action"],
    status: WorkspaceAuditEvent["status"],
    target: string,
    detail: string
  ) {
    workspace.audit.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      workspaceId: workspace.id,
      action,
      status,
      target,
      detail
    });
  }

  private async resolveInsideWorkspace(workspace: WorkspaceRecord, relativePath: string, expected: "file" | "directory") {
    const input = relativePath.trim() || ".";
    if (!isPathLikeInputSafe(input)) {
      throw new WorkspaceError("path_not_allowed", "Path must be relative to the workspace.", 403);
    }

    const candidate = path.resolve(workspace.root, input);
    let realPath: string;
    try {
      realPath = await fs.realpath(candidate);
    } catch {
      throw new WorkspaceError("path_not_found", "Path was not found.", 404);
    }

    if (!isInsidePath(workspace.root, realPath)) {
      throw new WorkspaceError("path_not_allowed", "Resolved path is outside the workspace.", 403);
    }

    const stat = await fs.stat(realPath);
    if (expected === "file" && !stat.isFile()) {
      throw new WorkspaceError("path_not_file", "Path must point to a file.");
    }
    if (expected === "file" && SENSITIVE_FILE_NAMES.has(path.basename(realPath))) {
      throw new WorkspaceError("sensitive_file_not_readable", "Sensitive files cannot be read through the workspace API.", 403);
    }
    if (expected === "directory" && !stat.isDirectory()) {
      throw new WorkspaceError("path_not_directory", "Path must point to a directory.");
    }

    return realPath;
  }

  private async buildTree(workspace: WorkspaceRecord, entryPath: string, depth: number, counter: { value: number }) {
    const stat = await fs.lstat(entryPath);
    const relativePath = toPortableRelativePath(workspace.root, entryPath);
    const name = relativePath === "." ? path.basename(workspace.root) : path.basename(entryPath);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";

    counter.value += 1;
    const base: WorkspaceTreeEntry = {
      name,
      path: relativePath,
      kind,
      ...(stat.isFile() ? { size: stat.size } : {})
    };

    if (kind !== "directory" || depth <= 0 || counter.value >= MAX_TREE_ENTRIES) return base;

    const entries = await fs.readdir(entryPath, { withFileTypes: true });
    const children: WorkspaceTreeEntry[] = [];
    for (const entry of entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    })) {
      if (counter.value >= MAX_TREE_ENTRIES) break;
      if (DEFAULT_EXCLUDED_NAMES.has(entry.name) || SENSITIVE_FILE_NAMES.has(entry.name)) continue;
      children.push(await this.buildTree(workspace, path.join(entryPath, entry.name), depth - 1, counter));
    }

    return { ...base, children };
  }

  private flattenTree(entry: WorkspaceTreeEntry, lines: string[], depth = 0): boolean {
    if (lines.length >= MAX_CONTEXT_TREE_LINES) return true;

    const suffix = entry.kind === "directory" ? "/" : "";
    lines.push(`${"  ".repeat(depth)}${entry.name}${suffix}`);

    let truncated = false;
    for (const child of entry.children ?? []) {
      if (this.flattenTree(child, lines, depth + 1)) {
        truncated = true;
        break;
      }
    }
    return truncated;
  }

  private async *walkTextCandidateFiles(root: string): AsyncGenerator<string> {
    const stack = [root];
    while (stack.length) {
      const directory = stack.pop();
      if (!directory) continue;

      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (DEFAULT_EXCLUDED_NAMES.has(entry.name) || SENSITIVE_FILE_NAMES.has(entry.name)) continue;
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (entry.isFile()) {
          yield entryPath;
        }
      }
    }
  }
}
