import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("workspace registry", () => {
  let tmpDir;
  let cpbRoot;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-test-"));
    cpbRoot = tmpDir;
    process.env.CPB_ROOT = cpbRoot;
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
    delete process.env.CPB_ROOT;
  });

  it("returns empty list when no workspaces exist", async () => {
    const { listWorkspaces } = await import("../server/services/workspace-registry.js");
    const workspaces = await listWorkspaces(cpbRoot);
    assert.equal(workspaces.length, 0);
  });

  it("creates a SSH workspace descriptor", async () => {
    const { createWorkspace, loadWorkspace } = await import("../server/services/workspace-registry.js");

    const descriptor = {
      name: "test-ssh",
      displayName: "Test SSH Workspace",
      command: "ssh",
      args: ["-o", "ConnectTimeout=10", "example.com", "echo", "ready"],
      capabilities: ["execute"],
      defaultRoles: ["executor"],
      envPrefix: "CPB_WORKSPACE_TEST_SSH",
      stability: "experimental",
      description: "Test SSH workspace",
      workspace: {
        type: "ssh",
        host: "example.com",
        port: 22,
        user: "root",
        path: "/workspace",
        syncStrategy: "rsync",
      },
    };

    const created = await createWorkspace(cpbRoot, descriptor);
    assert.equal(created.name, "test-ssh");
    assert.equal(created.workspace.type, "ssh");

    const loaded = await loadWorkspace(cpbRoot, "test-ssh");
    assert.equal(loaded.name, "test-ssh");
    assert.equal(loaded.workspace.host, "example.com");
  });

  it("creates a devcontainer workspace descriptor", async () => {
    const { createWorkspace, loadWorkspace } = await import("../server/services/workspace-registry.js");

    const descriptor = {
      name: "test-devcontainer",
      displayName: "Test Devcontainer Workspace",
      command: "docker",
      args: ["ps", "--filter", "name=test-container"],
      capabilities: ["execute"],
      defaultRoles: ["executor"],
      envPrefix: "CPB_WORKSPACE_TEST_DEVCONTAINER",
      stability: "experimental",
      description: "Test devcontainer workspace",
      workspace: {
        type: "devcontainer",
        containerId: "test-container",
        image: "ubuntu:latest",
        dockerfilePath: ".devcontainer/Dockerfile",
        contextPath: ".",
        mountPoint: "/workspace",
      },
    };

    const created = await createWorkspace(cpbRoot, descriptor);
    assert.equal(created.name, "test-devcontainer");
    assert.equal(created.workspace.type, "devcontainer");

    const loaded = await loadWorkspace(cpbRoot, "test-devcontainer");
    assert.equal(loaded.name, "test-devcontainer");
    assert.equal(loaded.workspace.image, "ubuntu:latest");
  });

  it("lists all workspaces", async () => {
    const { listWorkspaces } = await import("../server/services/workspace-registry.js");
    const workspaces = await listWorkspaces(cpbRoot);
    assert.equal(workspaces.length, 2);
    assert.ok(workspaces.find((w) => w.name === "test-ssh"));
    assert.ok(workspaces.find((w) => w.name === "test-devcontainer"));
  });

  it("deletes a workspace", async () => {
    const { deleteWorkspace, loadWorkspace, listWorkspaces } = await import("../server/services/workspace-registry.js");

    const deleted = await deleteWorkspace(cpbRoot, "test-ssh");
    assert.equal(deleted, true);

    const loaded = await loadWorkspace(cpbRoot, "test-ssh");
    assert.equal(loaded, null);

    const workspaces = await listWorkspaces(cpbRoot);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, "test-devcontainer");
  });

  it("returns workspace metrics", async () => {
    const { getWorkspaceMetrics } = await import("../server/services/workspace-registry.js");
    const metrics = await getWorkspaceMetrics(cpbRoot);

    assert.equal(metrics.total, 1);
    assert.equal(metrics.byType.devcontainer, 1);
    assert.equal(metrics.byStability.experimental, 1);
    assert.ok(Array.isArray(metrics.details));
    assert.equal(metrics.details.length, 1);
  });

  it("rejects invalid descriptors", async () => {
    const { createWorkspace } = await import("../server/services/workspace-registry.js");

    await assert.rejects(
      async () => await createWorkspace(cpbRoot, { name: "invalid" }),
      /Invalid workspace descriptor/
    );
  });
});

describe("workspace CLI commands", () => {
  let tmpDir;
  let cpbRoot;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-workspace-cli-test-"));
    cpbRoot = tmpDir;
    process.env.CPB_ROOT = cpbRoot;
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
    delete process.env.CPB_ROOT;
  });

  it("init creates SSH workspace with --type ssh", async () => {
    const { run } = await import("../cli/commands/workspace.js");
    const exitCode = await run(
      ["init", "--name", "cli-ssh", "--type", "ssh", "--host", "test.example.com"],
      { cpbRoot }
    );
    assert.equal(exitCode, 0);

    const { loadWorkspace } = await import("../server/services/workspace-registry.js");
    const workspace = await loadWorkspace(cpbRoot, "cli-ssh");
    assert.ok(workspace);
    assert.equal(workspace.name, "cli-ssh");
    assert.equal(workspace.workspace.type, "ssh");
    assert.equal(workspace.workspace.host, "test.example.com");
  });

  it("init creates devcontainer workspace with --type devcontainer", async () => {
    const { run } = await import("../cli/commands/workspace.js");
    const exitCode = await run(
      ["init", "--name", "cli-devc", "--type", "devcontainer", "--image", "node:20"],
      { cpbRoot }
    );
    assert.equal(exitCode, 0);

    const { loadWorkspace } = await import("../server/services/workspace-registry.js");
    const workspace = await loadWorkspace(cpbRoot, "cli-devc");
    assert.ok(workspace);
    assert.equal(workspace.name, "cli-devc");
    assert.equal(workspace.workspace.type, "devcontainer");
    assert.equal(workspace.workspace.image, "node:20");
  });

  it("list returns workspaces in --json format", async () => {
    const { run } = await import("../cli/commands/workspace.js");

    let capturedOutput = "";
    const originalConsoleLog = console.log;
    console.log = (...args) => { capturedOutput += args.join(" "); };

    try {
      const exitCode = await run(["list", "--json"], { cpbRoot });
      assert.equal(exitCode, 0);

      const parsed = JSON.parse(capturedOutput);
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.length >= 2);
      assert.ok(parsed.find((w) => w.name === "cli-ssh"));
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it("status shows workspace details", async () => {
    const { run } = await import("../cli/commands/workspace.js");

    let capturedOutput = "";
    const originalConsoleLog = console.log;
    console.log = (...args) => { capturedOutput += args.join(" "); };

    try {
      const exitCode = await run(["status", "cli-ssh"], { cpbRoot });
      assert.equal(exitCode, 0);

      assert.ok(capturedOutput.includes("cli-ssh"));
      assert.ok(capturedOutput.includes("ssh"));
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it("doctor runs health checks", async () => {
    const { run } = await import("../cli/commands/workspace.js");

    let capturedOutput = "";
    const originalConsoleLog = console.log;
    console.log = (...args) => { capturedOutput += args.join(" "); };

    try {
      const exitCode = await run(["doctor"], { cpbRoot });
      // Doctor may warn about commands not in PATH, but should not fail
      assert.ok([0, 1].includes(exitCode));
      assert.ok(capturedOutput.includes("Workspace doctor") || capturedOutput.includes("No workspaces"));
    } finally {
      console.log = originalConsoleLog;
    }
  });
});
