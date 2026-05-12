import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceAuditEvent,
  WorkspaceDescriptor,
  WorkspaceDiffLine,
  WorkspaceFileRead,
  WorkspacePatchPreview,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
  WorkspaceTreeEntry
} from "@webcode/core";

const DEFAULT_EXCLUDED_NAMES = new Set([".git", "node_modules", "dist", ".logs", ".vite"]);
const SENSITIVE_FILE_NAMES = new Set([".env", ".env.local", ".env.production", ".env.development"]);
const MAX_READ_BYTES = 256 * 1024;
const MAX_PATCH_PREVIEW_BYTES = MAX_READ_BYTES;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_TREE_DEPTH = 6;
const MAX_TREE_ENTRIES = 600;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 2_000;
const MAX_QUERY_LENGTH = 200;
const MAX_DIFF_LINES = 800;
const DIFF_CONTEXT_LINES = 3;

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
    this.audit(workspace, "register_workspace", "allowed", ".", `Registered workspace ${workspace.name}.`);
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
