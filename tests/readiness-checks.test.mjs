import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  deriveSummary,
  formatReadinessHuman,
  formatReadinessJson,
  runReadinessChecks,
  runReleaseDoctorChecks,
  formatReleaseDoctorHuman,
  formatReleaseDoctorJson,
} from "../server/services/readiness-checks.js";

let tmpDir;
let cpbRoot;
let hubRoot;
let origEnv;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "cpb-readiness-test-"));
  cpbRoot = path.join(tmpDir, "cpb");
  hubRoot = path.join(tmpDir, "hub");
  await fs.mkdir(cpbRoot, { recursive: true });
  await fs.mkdir(hubRoot, { recursive: true });
  origEnv = { ...process.env };
  process.env.CPB_ROOT = cpbRoot;
  process.env.CPB_HUB_ROOT = hubRoot;
  delete process.env.CPB_RUNTIME;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  process.env = origEnv;
});

// --- Result model tests ---

test("deriveSummary counts statuses correctly", () => {
  const checks = [
    { id: "a", status: "ok" },
    { id: "b", status: "ok" },
    { id: "c", status: "warn" },
    { id: "d", status: "error" },
    { id: "e", status: "skipped" },
  ];
  const summary = deriveSummary(checks);
  assert.equal(summary.ok, 2);
  assert.equal(summary.warn, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.success, false);
});

test("deriveSummary success is true when no errors", () => {
  const summary = deriveSummary([
    { id: "a", status: "ok" },
    { id: "b", status: "warn" },
    { id: "c", status: "skipped" },
  ]);
  assert.equal(summary.success, true);
});

// --- runReadinessChecks basic contract ---

test("runReadinessChecks returns structured result with all required fields", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });

  assert.equal(result.command, "cpb doctor");
  assert.ok(result.generatedAt);
  assert.ok(result.summary);
  assert.ok(Array.isArray(result.checks));
  assert.ok(result.checks.length >= 16);

  const ids = result.checks.map((c) => c.id);
  const requiredIds = [
    "node-version", "npm-version", "git-version",
    "common-sh", "server-deps",
    "disk-project", "disk-hub",
    "acp-adapter-codex", "acp-adapter-claude",
    "rust-runtime",
    "hub-liveness", "hub-writability",
    "registry-consistency",
    "stale-jobs", "stale-workers",
    "orphan-leases",
    "provider-backoff",
  ];
  for (const rid of requiredIds) {
    assert.ok(ids.includes(rid), `missing check: ${rid}`);
  }
});

test("each check has stable id, category, status, severity, message", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  for (const check of result.checks) {
    assert.ok(check.id, `check missing id: ${JSON.stringify(check)}`);
    assert.ok(check.category, `check missing category: ${check.id}`);
    assert.ok(["ok", "warn", "error", "skipped"].includes(check.status), `invalid status for ${check.id}: ${check.status}`);
    assert.ok(check.severity, `check missing severity: ${check.id}`);
    assert.ok(typeof check.message === "string" && check.message.length > 0, `check missing message: ${check.id}`);
  }
});

// --- Rust runtime ---

test("Rust runtime is skipped when CPB_RUNTIME is not set", async () => {
  delete process.env.CPB_RUNTIME;
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const rust = result.checks.find((c) => c.id === "rust-runtime");
  assert.equal(rust.status, "skipped");
  assert.ok(!result.summary.success || result.summary.success);
});

// Rust runtime is always skipped — Node is the only workflow backend.
// The legacy Rust adapter (runtime-cli.js) remains for diagnostics only.
test("Rust runtime is always skipped regardless of CPB_RUNTIME", async () => {
  process.env.CPB_RUNTIME = "rust";
  process.env.CPB_RUNTIME_BIN = path.join(tmpDir, "nonexistent-binary");
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const rust = result.checks.find((c) => c.id === "rust-runtime");
  assert.equal(rust.status, "skipped");
  delete process.env.CPB_RUNTIME;
  delete process.env.CPB_RUNTIME_BIN;
});

// --- Hub readiness ---

test("Hub liveness reports warn when hub not started", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const hub = result.checks.find((c) => c.id === "hub-liveness");
  assert.ok(hub.status === "warn" || hub.status === "ok", `unexpected hub status: ${hub.status}`);
});

test("Hub liveness detects stale hub state (dead PID)", async () => {
  const stateDir = path.join(hubRoot, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "hub.json"),
    JSON.stringify({ pid: 9999999, health: "alive", startedAt: new Date().toISOString(), version: "0.2.0" }),
    "utf8",
  );
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const hub = result.checks.find((c) => c.id === "hub-liveness");
  assert.equal(hub.status, "warn");
  assert.match(hub.message, /process gone|not alive/i);
});

test("Hub writability succeeds on writable directory", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const w = result.checks.find((c) => c.id === "hub-writability");
  assert.equal(w.status, "ok");
});

// --- Stale workers ---

test("Stale workers detected when heartbeat is old", async () => {
  const registry = { version: 1, updatedAt: new Date().toISOString(), projects: {
    "test-proj": {
      id: "test-proj",
      name: "Test",
      sourcePath: tmpDir,
      enabled: true,
      worker: {
        workerId: "w-1",
        pid: 12345,
        status: "online",
        lastSeenAt: new Date(Date.now() - 300_000).toISOString(),
      },
    },
  } };
  await fs.mkdir(path.join(hubRoot), { recursive: true });
  await fs.writeFile(
    path.join(hubRoot, "projects.json"),
    JSON.stringify(registry),
    "utf8",
  );
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const workers = result.checks.find((c) => c.id === "stale-workers");
  assert.equal(workers.status, "warn");
  assert.ok(workers.details.length > 0);
});

// --- Orphan leases ---

test("Orphan leases detected when lease has no matching job", async () => {
  const leasesDir = path.join(cpbRoot, "cpb-task", "leases");
  await fs.mkdir(leasesDir, { recursive: true });
  await fs.writeFile(
    path.join(leasesDir, "orphan-lease-001.json"),
    JSON.stringify({ leaseId: "orphan-lease-001", phase: "execute", expiresAt: new Date(Date.now() + 60000).toISOString(), ownerPid: 99999 }),
    "utf8",
  );
  // Ensure jobs index exists so listJobs doesn't throw
  const indexPath = path.join(cpbRoot, "cpb-task", "jobs-index.json");
  await fs.writeFile(indexPath, JSON.stringify({ _meta: { version: 1, updatedAt: new Date().toISOString(), jobCount: 0 }, jobs: {} }), "utf8");
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const orphan = result.checks.find((c) => c.id === "orphan-leases");
  assert.equal(orphan.status, "warn");
  assert.ok(orphan.remediation);
  assert.ok(Array.isArray(orphan.details));
  assert.ok(orphan.details.length > 0);
});

test("No orphan leases when directory is empty", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const orphan = result.checks.find((c) => c.id === "orphan-leases");
  assert.equal(orphan.status, "ok");
});

// --- Stale jobs with missing lease ---

test("Stale jobs detected when running job has no lease", async () => {
  const jobId = "job-no-lease-test";
  const now = new Date().toISOString();
  // Create a jobs index with a running job that has no lease
  const indexPath = path.join(cpbRoot, "cpb-task", "jobs-index.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify({
    _meta: { version: 1, updatedAt: now, jobCount: 1 },
    jobs: {
      "test-proj:job-no-lease-test": {
        jobId,
        project: "test-proj",
        task: "test task",
        status: "executing",
        currentPhase: "execute",
        createdAt: now,
        updatedAt: now,
      },
    },
  }), "utf8");
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const stale = result.checks.find((c) => c.id === "stale-jobs");
  assert.equal(stale.status, "warn");
  assert.ok(stale.details.some((d) => d.issue === "no lease" || d.issue === "lease file missing"));
});

// --- Provider backoff ---

test("Provider backoff reports warn when rate limited", async () => {
  const providersDir = path.join(hubRoot, "providers");
  await fs.mkdir(providersDir, { recursive: true });
  const futureTs = new Date(Date.now() + 3600_000).toISOString();
  await fs.writeFile(
    path.join(providersDir, "rate-limits.json"),
    JSON.stringify({
      codex: {
        agent: "codex",
        untilTs: futureTs,
        reason: "too many requests api_key=sk-secret123 Bearer tok_abc",
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf8",
  );
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const backoff = result.checks.find((c) => c.id === "provider-backoff");
  assert.equal(backoff.status, "warn");
  assert.ok(backoff.details.length > 0);
});

test("Provider backoff is ok when no rate limits file", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const backoff = result.checks.find((c) => c.id === "provider-backoff");
  assert.equal(backoff.status, "ok");
});

// --- Redaction ---

test("JSON output redacts secrets from provider backoff details", async () => {
  const providersDir = path.join(hubRoot, "providers");
  await fs.mkdir(providersDir, { recursive: true });
  const futureTs = new Date(Date.now() + 3600_000).toISOString();
  await fs.writeFile(
    path.join(providersDir, "rate-limits.json"),
    JSON.stringify({
      codex: {
        agent: "codex",
        untilTs: futureTs,
        reason: "rate limited api_key=sk-test-secret-key-123 Bearer tok_sensitivetoken",
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf8",
  );
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const jsonStr = formatReadinessJson(result);
  assert.ok(!jsonStr.includes("sk-test-secret-key-123"), "api key must be redacted in JSON");
  assert.ok(!jsonStr.includes("tok_sensitivetoken"), "bearer token must be redacted in JSON");
  assert.ok(jsonStr.includes("[REDACTED]"), "should contain REDACTED marker");
});

test("Human output does not leak secrets", async () => {
  const providersDir = path.join(hubRoot, "providers");
  await fs.mkdir(providersDir, { recursive: true });
  const futureTs = new Date(Date.now() + 3600_000).toISOString();
  await fs.writeFile(
    path.join(providersDir, "rate-limits.json"),
    JSON.stringify({
      codex: {
        agent: "codex",
        untilTs: futureTs,
        reason: "rate limited api_key=sk-human-secret-xyz Bearer tok_human_tok",
        updatedAt: new Date().toISOString(),
      },
    }),
    "utf8",
  );
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const human = formatReadinessHuman(result);
  // Human output renders message/remediation only (not raw details),
  // and redactSecrets is applied at the boundary for defense in depth.
  // Secrets must not appear in the rendered text.
  assert.ok(!human.includes("sk-human-secret-xyz"), "api key must not appear in human output");
  assert.ok(!human.includes("tok_human_tok"), "bearer token must not appear in human output");
});

// --- JSON output validity ---

test("formatReadinessJson produces valid JSON", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const jsonStr = formatReadinessJson(result);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.command, "cpb doctor");
  assert.ok(parsed.summary);
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.generatedAt);
});

test("JSON output has no extra stdout prose", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const jsonStr = formatReadinessJson(result);
  assert.ok(jsonStr.startsWith("{"), "JSON must start with {");
  assert.ok(jsonStr.trimEnd().endsWith("}"), "JSON must end with }");
});

// --- Human output format ---

test("formatReadinessHuman produces non-empty readable output", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const human = formatReadinessHuman(result);
  assert.ok(human.includes("Toolchain"));
  assert.ok(human.includes("Node.js"));
  assert.ok(human.includes("Git"));
});

// --- Missing adapter: deterministic test with fake commands ---

test("ACP adapter check returns error when adapter binary not found (deterministic)", async () => {
  const fakeCmd = path.join(tmpDir, "nonexistent-acp-binary-definitely-not-on-path");
  const result = await runReadinessChecks({
    cpbRoot,
    hubRoot,
    adapterOverrides: {
      codex: { command: fakeCmd, args: ["--help"] },
      claude: { command: fakeCmd, args: ["--help"] },
    },
  });
  const codex = result.checks.find((c) => c.id === "acp-adapter-codex");
  const claude = result.checks.find((c) => c.id === "acp-adapter-claude");
  assert.equal(codex.status, "error", "codex adapter must be error when binary missing");
  assert.ok(codex.remediation, "error status must include remediation");
  assert.ok(codex.details?.fallback || codex.details?.error, "error details must explain the problem");
  assert.equal(claude.status, "error", "claude adapter must be error when binary missing");
  assert.ok(claude.remediation, "claude error status must include remediation");
});

test("Missing adapter causes summary.success to be false (deterministic)", async () => {
  const fakeCmd = path.join(tmpDir, "nonexistent-acp-binary-definitely-not-on-path");
  const result = await runReadinessChecks({
    cpbRoot,
    hubRoot,
    adapterOverrides: {
      codex: { command: fakeCmd, args: ["--help"] },
      claude: { command: fakeCmd, args: ["--help"] },
    },
  });
  assert.equal(result.summary.success, false, "summary.success must be false when adapters are missing");
  assert.ok(result.summary.error >= 2, "at least 2 errors (one per adapter)");
});

test("ACP adapter structural contract: status is ok or error, not warn", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const codex = result.checks.find((c) => c.id === "acp-adapter-codex");
  const claude = result.checks.find((c) => c.id === "acp-adapter-claude");
  assert.ok(["ok", "error"].includes(codex.status), `codex adapter must be ok or error, got: ${codex.status}`);
  assert.ok(["ok", "error"].includes(claude.status), `claude adapter must be ok or error, got: ${claude.status}`);
  if (codex.status === "error") {
    assert.ok(codex.remediation, "error status must include remediation");
    assert.ok(codex.details?.fallback || codex.details?.error, "error details must explain the problem");
  }
  if (claude.status === "error") {
    assert.ok(claude.remediation, "error status must include remediation");
  }
});

// --- Registry consistency ---

test("Registry consistency reports ok for empty registry", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const reg = result.checks.find((c) => c.id === "registry-consistency");
  assert.equal(reg.status, "ok");
});

test("Registry consistency detects dead worker PID", async () => {
  const registry = { version: 1, updatedAt: new Date().toISOString(), projects: {
    "dead-worker-proj": {
      id: "dead-worker-proj",
      name: "Dead Worker",
      sourcePath: tmpDir,
      enabled: true,
      worker: {
        workerId: "w-dead",
        pid: 9999998,
        status: "online",
        lastSeenAt: new Date().toISOString(),
      },
    },
  } };
  await fs.writeFile(
    path.join(hubRoot, "projects.json"),
    JSON.stringify(registry),
    "utf8",
  );
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const reg = result.checks.find((c) => c.id === "registry-consistency");
  assert.equal(reg.status, "warn");
  assert.ok(reg.details.some((d) => d.issue.includes("not alive")));
});

// --- common.sh and server deps (old doctor compatibility) ---

test("common.sh check reports warn when file missing", async () => {
  // tmpDir-based cpbRoot has no bridges/common.sh
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const sh = result.checks.find((c) => c.id === "common-sh");
  assert.equal(sh.status, "warn");
  assert.ok(sh.remediation);
});

test("common.sh check reports ok when file exists", async () => {
  const bridgesDir = path.join(cpbRoot, "bridges");
  await fs.mkdir(bridgesDir, { recursive: true });
  await fs.writeFile(path.join(bridgesDir, "common.sh"), "# common.sh\n", "utf8");
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const sh = result.checks.find((c) => c.id === "common-sh");
  assert.equal(sh.status, "ok");
});

test("server-deps check reports warn when node_modules missing", async () => {
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const deps = result.checks.find((c) => c.id === "server-deps");
  assert.equal(deps.status, "warn");
  assert.ok(deps.remediation);
});

test("server-deps check reports ok when node_modules exists", async () => {
  const serverDir = path.join(cpbRoot, "server", "node_modules");
  await fs.mkdir(serverDir, { recursive: true });
  const result = await runReadinessChecks({ cpbRoot, hubRoot });
  const deps = result.checks.find((c) => c.id === "server-deps");
  assert.equal(deps.status, "ok");
});

// --- Release doctor checks ---

test("runReleaseDoctorChecks returns structured result with all required fields", async () => {
  const result = await runReleaseDoctorChecks({ cpbRoot, env: process.env });
  assert.equal(result.command, "cpb release doctor");
  assert.ok(result.generatedAt);
  assert.ok(result.summary);
  assert.ok(Array.isArray(result.checks));
  assert.equal(result.checks.length, 6);

  const ids = result.checks.map(c => c.id);
  const requiredIds = [
    "release.current_metadata",
    "release.executor_root",
    "release.runtime_root",
    "release.state_format",
    "release.launcher_health",
    "release.job_pinning",
  ];
  for (const rid of requiredIds) {
    assert.ok(ids.includes(rid), `missing release check: ${rid}`);
  }
});

test("release doctor checks use ok/warn/fail statuses", async () => {
  const result = await runReleaseDoctorChecks({ cpbRoot, env: process.env });
  for (const check of result.checks) {
    assert.ok(
      ["ok", "warn", "fail"].includes(check.status),
      `invalid status for ${check.id}: ${check.status}`,
    );
  }
});

test("release doctor warns when no release selected", async () => {
  const result = await runReleaseDoctorChecks({ cpbRoot, env: process.env });
  const current = result.checks.find(c => c.id === "release.current_metadata");
  assert.equal(current.status, "warn");
  assert.ok(current.guidance);
});

test("release doctor ok when valid release selected", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await fs.mkdir(path.join(sourceRoot, "bridges"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "bridges", "common.sh"), "# sh\n");
  await fs.writeFile(path.join(sourceRoot, "bridges", "run-pipeline.mjs"), "// p\n");
  await fs.writeFile(path.join(sourceRoot, "bridges", "project-worker.mjs"), "// w\n");
  await fs.writeFile(path.join(sourceRoot, "bridges", "job-runner.mjs"), "// r\n");
  await fs.mkdir(path.join(sourceRoot, "server", "services"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "server", "services", "job-store.js"), "// js\n");
  await fs.writeFile(path.join(sourceRoot, "cpb"), "#!/bin/bash\n");
  await fs.writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "cpb", version: "0.1.0" }));
  await fs.mkdir(path.join(sourceRoot, "profiles"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "templates"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "wiki", "system"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "wiki", "projects"), { recursive: true });

  // Set CPB_HOME so all operations agree on the release store root
  const prevHome = process.env.CPB_HOME;
  process.env.CPB_HOME = tmpDir;

  try {
    const { installRelease, selectRelease } = await import("../server/services/release-store.js");
    const storeRoot = path.join(tmpDir, "releases");
    await installRelease({ sourceRoot, destRoot: storeRoot, name: "test-rel-1", env: process.env, now: new Date() });
    await selectRelease({ releaseId: "test-rel-1", destRoot: storeRoot, env: process.env });

    const result = await runReleaseDoctorChecks({ cpbRoot, env: process.env });
    const current = result.checks.find(c => c.id === "release.current_metadata");
    assert.equal(current.status, "ok");
    assert.ok(current.message.includes("test-rel-1"));
  } finally {
    if (prevHome !== undefined) process.env.CPB_HOME = prevHome;
    else delete process.env.CPB_HOME;
  }
});

test("formatReleaseDoctorHuman produces readable output", async () => {
  const result = await runReleaseDoctorChecks({ cpbRoot, env: process.env });
  const human = formatReleaseDoctorHuman(result);
  assert.ok(human.includes("Release Doctor"));
  assert.ok(human.includes("release.current_metadata"));
});

test("formatReleaseDoctorJson produces valid JSON", async () => {
  const result = await runReleaseDoctorChecks({ cpbRoot, env: process.env });
  const jsonStr = formatReleaseDoctorJson(result);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.command, "cpb release doctor");
  assert.ok(parsed.summary);
  assert.ok(Array.isArray(parsed.checks));
});
