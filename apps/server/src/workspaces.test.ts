import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceError, WorkspaceService } from "./workspaces.js";

async function createWorkspaceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "webcode-workspace-"));
  const service = new WorkspaceService({ allowedRoots: [root] });
  const workspace = await service.register(root, "fixture");
  return { root, service, workspace };
}

function collectTreePaths(entry: { path: string; children?: Array<{ path: string; children?: any[] }> }, paths = new Set<string>()) {
  paths.add(entry.path);
  for (const child of entry.children ?? []) collectTreePaths(child, paths);
  return paths;
}

test("workspace tree and search hide sensitive files", async () => {
  const { root, service, workspace } = await createWorkspaceFixture();
  try {
    await writeFile(path.join(root, ".env.test"), "TOKEN=secret\n", "utf8");
    await writeFile(path.join(root, ".npmrc"), "//registry.example/:_authToken=secret\n", "utf8");
    await writeFile(path.join(root, "private.pem"), "-----BEGIN PRIVATE KEY-----\nsecret\n", "utf8");
    await writeFile(path.join(root, ".env.example"), "TOKEN=\n", "utf8");
    await writeFile(path.join(root, "README.md"), "visible tokenless documentation\n", "utf8");

    const tree = await service.tree(workspace.id, ".", 2);
    const childNames = new Set(tree.root.children?.map((entry) => entry.name));
    assert.equal(childNames.has(".env.test"), false);
    assert.equal(childNames.has(".npmrc"), false);
    assert.equal(childNames.has("private.pem"), false);
    assert.equal(childNames.has(".env.example"), true);
    assert.equal(childNames.has("README.md"), true);

    const search = await service.search(workspace.id, "secret", 20);
    assert.deepEqual(search.matches, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace read rejects sensitive file names and credential directories", async () => {
  const { root, service, workspace } = await createWorkspaceFixture();
  try {
    await writeFile(path.join(root, ".env.production.local"), "PASSWORD=secret\n", "utf8");
    await writeFile(path.join(root, "deploy.key"), "secret\n", "utf8");
    await writeFile(path.join(root, ".env.example"), "PASSWORD=\n", "utf8");

    await assert.rejects(
      () => service.readFile(workspace.id, ".env.production.local"),
      (error) => error instanceof WorkspaceError && error.code === "sensitive_file_not_readable"
    );
    await assert.rejects(
      () => service.readFile(workspace.id, "deploy.key"),
      (error) => error instanceof WorkspaceError && error.code === "sensitive_file_not_readable"
    );

    const example = await service.readFile(workspace.id, ".env.example");
    assert.equal(example.content, "PASSWORD=\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace tree and search hide nested credential directories", async () => {
  const { root, service, workspace } = await createWorkspaceFixture();
  try {
    await mkdir(path.join(root, ".config", "gcloud"), { recursive: true });
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(
      path.join(root, ".config", "gcloud", "application_default_credentials.json"),
      "super-secret-gcloud-token\n",
      "utf8"
    );
    await writeFile(path.join(root, ".ssh", "config"), "super-secret-ssh-host\n", "utf8");
    await writeFile(path.join(root, "notes.txt"), "ordinary public text\n", "utf8");

    const tree = await service.tree(workspace.id, ".", 4);
    const paths = collectTreePaths(tree.root);
    assert.equal(paths.has(".config/gcloud"), false);
    assert.equal(paths.has(".config/gcloud/application_default_credentials.json"), false);
    assert.equal(paths.has(".ssh"), false);
    assert.equal(paths.has("notes.txt"), true);

    const search = await service.search(workspace.id, "super-secret", 20);
    assert.deepEqual(search.matches, []);
    await assert.rejects(
      () => service.readFile(workspace.id, ".config/gcloud/application_default_credentials.json"),
      (error) => error instanceof WorkspaceError && error.code === "sensitive_file_not_readable"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
