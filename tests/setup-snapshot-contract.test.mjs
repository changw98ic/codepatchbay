import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeCommandProbe,
  detectSetupEnvironment,
} from "../core/setup/detect.js";

// --- normalizeCommandProbe ---

describe("normalizeCommandProbe", () => {
  it("returns installed record for successful probe", () => {
    const result = normalizeCommandProbe({
      ok: true,
      stdout: "v1.2.3\n",
      stderr: "",
    });
    assert.equal(result.installed, true);
    assert.equal(result.status, "installed");
    assert.equal(result.version, "v1.2.3");
    assert.equal(result.error, null);
  });

  it("extracts version from stderr when stdout is empty", () => {
    const result = normalizeCommandProbe({
      ok: true,
      stdout: "",
      stderr: "2.40.0\nsome other output",
    });
    assert.equal(result.installed, true);
    assert.equal(result.version, "2.40.0");
  });

  it("returns structured missing record for ENOENT (binary not found)", () => {
    const error = new Error("spawn codex ENOENT");
    error.code = "ENOENT";
    const result = normalizeCommandProbe({
      ok: false,
      stdout: "",
      stderr: "",
      error,
    });
    assert.equal(result.installed, false);
    assert.equal(result.status, "missing");
    assert.equal(result.version, null);
    assert.ok(result.error);
    assert.equal(result.error.kind, "missing");
    assert.equal(result.error.code, "ENOENT");
  });

  it("returns structured timeout record for killed process", () => {
    const error = new Error("signal SIGTERM");
    error.killed = true;
    error.signal = "SIGTERM";
    const result = normalizeCommandProbe({
      ok: false,
      stdout: "",
      stderr: "",
      error,
    });
    assert.equal(result.installed, false);
    assert.equal(result.status, "timeout");
    assert.equal(result.version, null);
    assert.ok(result.error);
    assert.equal(result.error.kind, "timeout");
    assert.equal(result.error.signal, "SIGTERM");
  });

  it("returns structured timeout record for ETIMEDOUT code", () => {
    const error = new Error("timed out");
    error.code = "ETIMEDOUT";
    const result = normalizeCommandProbe({
      ok: false,
      stdout: "",
      stderr: "",
      error,
    });
    assert.equal(result.installed, false);
    assert.equal(result.status, "timeout");
    assert.ok(result.error);
    assert.equal(result.error.kind, "timeout");
  });

  it("returns generic error record for other failures", () => {
    const error = new Error("EPERM");
    error.code = "EPERM";
    const result = normalizeCommandProbe({
      ok: false,
      stdout: "partial",
      stderr: "",
      error,
    });
    assert.equal(result.installed, false);
    assert.equal(result.status, "error");
    assert.equal(result.version, null);
    assert.equal(result.error.kind, "error");
    assert.equal(result.error.code, "EPERM");
  });

  it("returns unavailable record when no error object is present", () => {
    const result = normalizeCommandProbe({ ok: false, stdout: "", stderr: "" });
    assert.equal(result.installed, false);
    assert.equal(result.status, "unavailable");
    assert.equal(result.error.kind, "unavailable");
  });
});

// --- detectSetupEnvironment snapshot contract ---

describe("detectSetupEnvironment snapshot contract", () => {
  const mockRunCommand = async (command, args) => {
    const versions = {
      node: "v22.0.0",
      git: "git version 2.45.0",
      npm: "10.5.0",
      brew: "Homebrew 4.2.0",
    };
    const name = command;
    if (versions[name]) {
      return { ok: true, stdout: versions[name] + "\n", stderr: "" };
    }
    // Agent binaries: simulate codex installed, others missing
    if (name === "codex") {
      return { ok: true, stdout: "1.0.0\n", stderr: "" };
    }
    const error = new Error(`spawn ${name} ENOENT`);
    error.code = "ENOENT";
    return { ok: false, stdout: "", stderr: "", error };
  };

  it("snapshot includes schemaVersion, generatedAt, system, tools, agents", async () => {
    const snapshot = await detectSetupEnvironment({
      runCommand: mockRunCommand,
      platform: "darwin",
      arch: "arm64",
    });

    assert.ok(snapshot.schemaVersion, "missing schemaVersion");
    assert.ok(snapshot.generatedAt, "missing generatedAt");
    assert.ok(snapshot.system, "missing system");
    assert.ok(snapshot.tools, "missing tools");
    assert.ok(snapshot.agents, "missing agents");

    assert.equal(typeof snapshot.schemaVersion, "number");
    assert.match(snapshot.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("system contains platform, arch, release, shell", async () => {
    const snapshot = await detectSetupEnvironment({
      runCommand: mockRunCommand,
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(snapshot.system.platform, "darwin");
    assert.equal(snapshot.system.arch, "arm64");
    assert.ok(snapshot.system.release);
    assert.ok(snapshot.system.shell !== undefined);
  });

  it("tools contains node, git, npm, brew probes", async () => {
    const snapshot = await detectSetupEnvironment({
      runCommand: mockRunCommand,
    });

    for (const tool of ["node", "git", "npm", "brew"]) {
      const probe = snapshot.tools[tool];
      assert.ok(probe, `missing tool: ${tool}`);
      assert.equal(typeof probe.installed, "boolean", `${tool}.installed should be boolean`);
      assert.ok("status" in probe, `${tool} missing status`);
      assert.ok("version" in probe, `${tool} missing version`);
      assert.ok("error" in probe, `${tool} missing error`);
    }
  });

  it("agents contains structured records for all catalog entries", async () => {
    const snapshot = await detectSetupEnvironment({
      runCommand: mockRunCommand,
    });

    assert.ok(Object.keys(snapshot.agents).length > 0, "agents should not be empty");

    for (const [id, agent] of Object.entries(snapshot.agents)) {
      assert.equal(typeof agent.installed, "boolean", `${id}.installed should be boolean`);
      assert.ok("status" in agent, `${id} missing status`);
      assert.ok("version" in agent, `${id} missing version`);
      assert.ok("error" in agent, `${id} missing error`);
      assert.ok("id" in agent, `${id} missing id`);
      assert.ok("displayName" in agent, `${id} missing displayName`);
      assert.ok("binary" in agent, `${id} missing binary`);
      assert.ok("roles" in agent, `${id} missing roles`);
      assert.ok("capabilities" in agent, `${id} missing capabilities`);
    }
  });

  it("missing agents are structured records with status=missing, not thrown errors", async () => {
    const allMissing = async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    });

    const snapshot = await detectSetupEnvironment({
      runCommand: allMissing,
    });

    for (const [id, agent] of Object.entries(snapshot.agents)) {
      assert.equal(agent.installed, false, `${id} should not be installed`);
      assert.equal(agent.status, "missing", `${id} should have status=missing`);
      assert.equal(agent.version, null, `${id} version should be null`);
      assert.ok(agent.error, `${id} should have error record`);
      assert.equal(agent.error.kind, "missing", `${id} error.kind should be missing`);
    }
  });

  it("timeout agents are structured records with status=timeout", async () => {
    const allTimeout = async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("signal SIGTERM"), { killed: true, signal: "SIGTERM" }),
    });

    const snapshot = await detectSetupEnvironment({
      runCommand: allTimeout,
    });

    for (const [id, agent] of Object.entries(snapshot.agents)) {
      assert.equal(agent.installed, false, `${id} should not be installed`);
      assert.equal(agent.status, "timeout", `${id} should have status=timeout`);
      assert.ok(agent.error, `${id} should have error record`);
      assert.equal(agent.error.kind, "timeout", `${id} error.kind should be timeout`);
    }
  });
});

// --- CLI integration: cpb agents detect --json ---

describe("cli/commands/agents detect --json outputs contract shape", () => {
  it("outputs valid JSON with all contract fields", async () => {
    const { run } = await import("../cli/commands/agents.js");

    const originalLog = console.log;
    let captured = "";
    console.log = (msg) => { captured += msg; };

    try {
      await run(["detect", "--json"]);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(captured);
    assert.ok(parsed.schemaVersion, "missing schemaVersion");
    assert.ok(parsed.generatedAt, "missing generatedAt");
    assert.ok(parsed.system, "missing system");
    assert.ok(parsed.tools, "missing tools");
    assert.ok(parsed.agents, "missing agents");
  });
});
