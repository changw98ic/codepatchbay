import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import fastify from "fastify";
import sensible from "@fastify/sensible";
import { workspaceRoutes } from "../server/routes/workspace.js";
import {
  configDir,
  validateDescriptor,
  loadWorkspace,
  listWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../server/services/workspace-registry.js";

describe("configDir", () => {
  it("returns cpb-task/workspaces by default", () => {
    const tmpDir = "/tmp/test";
    const dir = configDir(tmpDir);
    assert.equal(dir, path.join(tmpDir, "cpb-task", "workspaces"));
  });

  it("respects CPB_WORKSPACE_CONFIG_DIR env override", () => {
    process.env.CPB_WORKSPACE_CONFIG_DIR = "/custom/path";
    try {
      const dir = configDir("/tmp/test");
      assert.equal(dir, "/custom/path");
    } finally {
      delete process.env.CPB_WORKSPACE_CONFIG_DIR;
    }
  });
});

describe("validateDescriptor", () => {
  it("accepts valid minimal descriptor", () => {
    const d = { name: "test", command: "echo", workspace: { type: "local" } };
    assert.equal(validateDescriptor(d), true);
  });

  it("accepts valid descriptor with optional fields", () => {
    const d = {
      name: "test-01",
      command: "node",
      args: ["--version"],
      env: { PATH: "/bin" },
      workspace: { type: "ssh", host: "example.com" },
    };
    assert.equal(validateDescriptor(d), true);
  });

  it("rejects non-object descriptor", () => {
    assert.throws(() => validateDescriptor(null));
    assert.throws(() => validateDescriptor("string"));
    assert.throws(() => validateDescriptor([]));
  });

  it("rejects missing name", () => {
    assert.throws(() => validateDescriptor({ command: "x", workspace: { type: "y" } }), /name/);
  });

  it("rejects invalid name format", () => {
    assert.throws(() => validateDescriptor({ name: "-bad", command: "x", workspace: { type: "y" } }), /name/);
    assert.throws(() => validateDescriptor({ name: "bad!", command: "x", workspace: { type: "y" } }), /name/);
    assert.throws(() => validateDescriptor({ name: "bad name", command: "x", workspace: { type: "y" } }), /name/);
  });

  it("rejects missing or empty command", () => {
    assert.throws(() => validateDescriptor({ name: "test", workspace: { type: "y" } }), /command/);
    assert.throws(() => validateDescriptor({ name: "test", command: "", workspace: { type: "y" } }), /command/);
    assert.throws(() => validateDescriptor({ name: "test", command: "  ", workspace: { type: "y" } }), /command/);
  });

  it("rejects missing or invalid workspace config", () => {
    assert.throws(() => validateDescriptor({ name: "test", command: "x" }), /workspace/);
    assert.throws(() => validateDescriptor({ name: "test", command: "x", workspace: null }), /workspace/);
    assert.throws(() => validateDescriptor({ name: "test", command: "x", workspace: "string" }), /workspace/);
  });

  it("rejects missing or empty workspace type", () => {
    assert.throws(() => validateDescriptor({ name: "test", command: "x", workspace: {} }), /type/);
    assert.throws(() => validateDescriptor({ name: "test", command: "x", workspace: { type: "" } }), /type/);
    assert.throws(() => validateDescriptor({ name: "test", command: "x", workspace: { type: "  " } }), /type/);
  });
});

describe("loadWorkspace with isolated dir", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-load-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("returns null for nonexistent workspace", async () => {
    const result = await loadWorkspace(tmpDir, "nonexistent");
    assert.equal(result, null);
  });

  it("loads valid workspace from file", async () => {
    const dir = configDir(tmpDir);
    await mkdir(dir, { recursive: true });
    const wsPath = path.join(dir, "test-ws.json");
    const content = JSON.stringify({
      name: "test-ws",
      command: "echo",
      workspace: { type: "local" },
    });
    await writeFile(wsPath, content, "utf8");

    const result = await loadWorkspace(tmpDir, "test-ws");
    assert.equal(result.name, "test-ws");
    assert.equal(result.command, "echo");
    assert.equal(result.workspace.type, "local");
  });

  it("returns null for invalid JSON", async () => {
    const dir = configDir(tmpDir);
    await mkdir(dir, { recursive: true });
    const wsPath = path.join(dir, "bad-ws.json");
    await writeFile(wsPath, "not json", "utf8");

    const result = await loadWorkspace(tmpDir, "bad-ws");
    assert.equal(result, null);
  });
});

describe("listWorkspaces with isolated dir", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-list-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("returns empty array when dir does not exist", async () => {
    const result = await listWorkspaces(tmpDir);
    assert.deepEqual(result, []);
  });

  it("lists all valid workspaces", async () => {
    const subDir = path.join(tmpDir, "test-list-valid");
    const wsDir = path.join(subDir, "cpb-task", "workspaces");
    await mkdir(wsDir, { recursive: true });

    await writeFile(path.join(wsDir, "ws1.json"), JSON.stringify({
      name: "ws1",
      command: "echo",
      workspace: { type: "local" },
    }), "utf8");
    await writeFile(path.join(wsDir, "ws2.json"), JSON.stringify({
      name: "ws2",
      command: "node",
      workspace: { type: "ssh" },
    }), "utf8");
    // Skip non-json files
    await writeFile(path.join(wsDir, "readme.txt"), "text", "utf8");
    // Skip invalid names
    await writeFile(path.join(wsDir, "-bad.json"), "{}", "utf8");

    const result = await listWorkspaces(subDir);
    assert.equal(result.length, 2);
    const names = result.map((w) => w.name).sort();
    assert.deepEqual(names, ["ws1", "ws2"]);
  });

  it("skips invalid descriptor files", async () => {
    const subDir = path.join(tmpDir, "test-skip-invalid");
    const wsDir = path.join(subDir, "cpb-task", "workspaces");
    await mkdir(wsDir, { recursive: true });

    await writeFile(path.join(wsDir, "good.json"), JSON.stringify({
      name: "good",
      command: "echo",
      workspace: { type: "local" },
    }), "utf8");
    await writeFile(path.join(wsDir, "bad.json"), "invalid json", "utf8");

    const result = await listWorkspaces(subDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "good");
  });
});

describe("createWorkspace with isolated dir", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-create-"));
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("creates workspace with metadata", async () => {
    const descriptor = {
      name: "new-ws",
      command: "test",
      workspace: { type: "local" },
    };
    const result = await createWorkspace(tmpDir, descriptor);

    assert.equal(result.name, "new-ws");
    assert.equal(result.command, "test");
    assert.ok(result.metadata.createdAt);
    assert.ok(typeof result.metadata.createdAt === "string");
  });

  it("throws when workspace already exists", async () => {
    const descriptor = {
      name: "dup-ws",
      command: "test",
      workspace: { type: "local" },
    };
    await createWorkspace(tmpDir, descriptor);

    await assert.rejects(
      async () => await createWorkspace(tmpDir, descriptor),
      /already exists/
    );
  });

  it("throws for invalid descriptor", async () => {
    await assert.rejects(
      async () => await createWorkspace(tmpDir, { name: "bad" }),
      /command/
    );
  });
});

describe("updateWorkspace with isolated dir", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-update-"));
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("merges updates and sets updatedAt", async () => {
    await createWorkspace(tmpDir, {
      name: "update-me",
      command: "old",
      workspace: { type: "local" },
    });

    const result = await updateWorkspace(tmpDir, "update-me", {
      command: "new",
      args: ["--flag"],
    });

    assert.equal(result.command, "new");
    assert.deepEqual(result.args, ["--flag"]);
    assert.ok(result.metadata.updatedAt);
  });

  it("throws for nonexistent workspace", async () => {
    await assert.rejects(
      async () => await updateWorkspace(tmpDir, "no-such", { command: "x" }),
      /not found/
    );
  });

  it("merges nested metadata", async () => {
    await createWorkspace(tmpDir, {
      name: "meta-ws",
      command: "test",
      workspace: { type: "local" },
      metadata: { custom: "value" },
    });

    const result = await updateWorkspace(tmpDir, "meta-ws", {
      metadata: { extra: "field" },
    });

    assert.equal(result.metadata.custom, "value");
    assert.equal(result.metadata.extra, "field");
  });
});

describe("deleteWorkspace with isolated dir", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-delete-"));
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("deletes existing workspace", async () => {
    await createWorkspace(tmpDir, {
      name: "delete-me",
      command: "test",
      workspace: { type: "local" },
    });

    const result = await deleteWorkspace(tmpDir, "delete-me");
    assert.equal(result, true);

    // Verify deletion
    const loaded = await loadWorkspace(tmpDir, "delete-me");
    assert.equal(loaded, null);
  });

  it("returns false for nonexistent workspace", async () => {
    const result = await deleteWorkspace(tmpDir, "no-such");
    assert.equal(result, false);
  });

  it("is idempotent", async () => {
    await createWorkspace(tmpDir, {
      name: "idempotent",
      command: "test",
      workspace: { type: "local" },
    });

    const first = await deleteWorkspace(tmpDir, "idempotent");
    const second = await deleteWorkspace(tmpDir, "idempotent");

    assert.equal(first, true);
    assert.equal(second, false);
  });
});

describe("workspace API routes", () => {
  let app;
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-api-test-"));
    process.env.CPB_ROOT = tmpDir;

    app = fastify();
    await app.register(sensible);
    app.addHook("onRequest", (req, _res, done) => {
      req.cpbRoot = tmpDir;
      done();
    });
    await app.register(workspaceRoutes, { prefix: "/api" });
    await app.ready();
  });

  after(async () => {
    await app.close();
    try { await rm(tmpDir, { recursive: true }); } catch {}
    delete process.env.CPB_ROOT;
  });

  it("GET /api/workspaces returns empty list initially", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces",
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.workspaces, []);
    assert.equal(body.count, 0);
  });

  it("POST /api/workspaces creates workspace", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: {
        name: "api-ws",
        command: "node",
        workspace: { type: "ssh" },
      },
    });
    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.equal(body.name, "api-ws");
    assert.ok(body.metadata?.createdAt);
  });

  it("POST /api/workspaces validates required fields", async () => {
    let response;

    // Missing name
    response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { command: "x", workspace: { type: "y" } },
    });
    assert.equal(response.statusCode, 400);

    // Missing command
    response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "test", workspace: { type: "y" } },
    });
    assert.equal(response.statusCode, 400);

    // Missing workspace
    response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "test", command: "x" },
    });
    assert.equal(response.statusCode, 400);

    // Invalid name format
    response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "-bad-", command: "x", workspace: { type: "y" } },
    });
    assert.equal(response.statusCode, 400);
  });

  it("POST /api/workspaces returns 409 for duplicate", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "dup", command: "x", workspace: { type: "y" } },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "dup", command: "x", workspace: { type: "y" } },
    });
    assert.equal(response.statusCode, 409);
  });

  it("GET /api/workspaces/:name returns workspace", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "get-me", command: "x", workspace: { type: "y" } },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces/get-me",
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.name, "get-me");
  });

  it("GET /api/workspaces/:name returns 404 for nonexistent", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces/no-such",
    });
    assert.equal(response.statusCode, 404);
  });

  it("GET /api/workspaces/:name validates name format", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces/-bad-",
    });
    assert.equal(response.statusCode, 400);
  });

  it("PATCH /api/workspaces/:name updates workspace", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "patch-me", command: "old", workspace: { type: "y" } },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/patch-me",
      payload: { command: "new", args: ["--flag"] },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.command, "new");
    assert.deepEqual(body.args, ["--flag"]);
  });

  it("DELETE /api/workspaces/:name deletes workspace", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "del-me", command: "x", workspace: { type: "y" } },
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/workspaces/del-me",
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.deleted, true);
  });

  it("DELETE /api/workspaces/:name returns 404 for nonexistent", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/workspaces/no-such",
    });
    assert.equal(response.statusCode, 404);
  });
});

// Polyfill beforeEach/afterEach for nested describe blocks
function beforeEach(fn) {
  before(fn);
}
function afterEach(fn) {
  after(fn);
}
