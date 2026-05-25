import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodePatchBayPrBody } from "../server/services/pr-body.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runCpb(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./cpb", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("cpb sdd init creates spec, design, task templates and trace schema", async () => {
  const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-sdd-init-"));
  try {
    const result = await runCpb(["sdd", "init", "frontend", "--json"], { CPB_ROOT: cpbRoot });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.project, "frontend");
    assert.equal(parsed.trace.schemaVersion, 1);
    assert.equal(parsed.trace.status, "initialized");
    assert.match(parsed.files.spec, /spec\.md$/);
    assert.match(parsed.files.design, /design\.md$/);
    assert.match(parsed.files.tasks, /tasks\.md$/);

    const spec = await readFile(path.join(cpbRoot, "wiki", "projects", "frontend", "sdd", "spec.md"), "utf8");
    const trace = JSON.parse(await readFile(path.join(cpbRoot, "wiki", "projects", "frontend", "sdd", "trace.json"), "utf8"));
    assert.match(spec, /# Spec/);
    assert.equal(trace.workflow, "sdd-standard");
    assert.equal(trace.planMode, "parent");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("cpb sdd bootstrap returns queue metadata for sdd-standard parent planning", async () => {
  const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-sdd-bootstrap-"));
  try {
    const result = await runCpb(["sdd", "bootstrap", "frontend", "--json"], { CPB_ROOT: cpbRoot });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.trace.status, "bootstrapped");
    assert.deepEqual(parsed.queueMetadata.workflow, "sdd-standard");
    assert.deepEqual(parsed.queueMetadata.planMode, "parent");
    assert.equal(parsed.queueMetadata.sddTrace.traceId, parsed.trace.traceId);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("PR body renders SDD trace when provided", () => {
  const body = buildCodePatchBayPrBody({
    job: { jobId: "job-sdd", project: "frontend", workflow: "sdd-standard" },
    sddTrace: {
      traceId: "sdd-frontend",
      spec: "wiki/projects/frontend/sdd/spec.md",
      design: "wiki/projects/frontend/sdd/design.md",
      tasks: "wiki/projects/frontend/sdd/tasks.md",
    },
  });

  assert.match(body, /## SDD Trace/);
  assert.match(body, /sdd-frontend/);
  assert.match(body, /spec\.md/);
  assert.match(body, /design\.md/);
  assert.match(body, /tasks\.md/);
});
