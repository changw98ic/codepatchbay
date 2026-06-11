import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendEvent, readEvents } from "../server/services/event/event-store.js";
import { createJob } from "../server/services/job/job-store.js";
import {
  buildExecutorJobPrompt,
  buildVerifierJobPrompt,
} from "../server/services/prompt/prompt-builder.js";
import {
  canWrite,
  getPhasePolicy,
  recordPermissionDenial,
} from "../server/services/permission-matrix.js";
import { registerProject } from "../server/services/hub/hub-registry.js";

test("job prompts use project runtime root and fail closed without a registered dataRoot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-prompt-runtime-"));
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "source");
  const dataRoot = path.join(hubRoot, "projects", "flow");
  const project = "flow";
  const jobId = "job-20260611-090000-runtime";
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  const previousProjectRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;

  try {
    process.env.CPB_HUB_ROOT = hubRoot;
    process.env.CPB_PROJECT_RUNTIME_ROOT = path.join(root, "stale-env-runtime");
    await mkdir(sourcePath, { recursive: true });
    await registerProject(hubRoot, {
      id: project,
      sourcePath,
      skipCodeGraphGate: true,
    });

    const legacyWiki = path.join(cpbRoot, "wiki", "projects", project);
    await mkdir(path.join(legacyWiki, "outputs"), { recursive: true });
    await writeFile(path.join(legacyWiki, "outputs", "deliverable-001.md"), "# Legacy Deliverable\n", "utf8");
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: "legacy task",
      workflow: "standard",
      sourceContext: { contextPackPath: "/legacy/context-pack.json" },
      ts: "2026-06-11T08:59:00.000Z",
    }, { legacyOnly: true });

    await mkdir(path.join(dataRoot, "wiki", "inbox"), { recursive: true });
    await mkdir(path.join(dataRoot, "wiki", "outputs"), { recursive: true });
    await writeFile(path.join(dataRoot, "wiki", "outputs", "deliverable-001.md"), "# Runtime Deliverable\n", "utf8");
    await createJob(cpbRoot, {
      project,
      jobId,
      task: "runtime task",
      workflow: "standard",
      dataRoot,
      sourceContext: { contextPackPath: "/runtime/context-pack.json" },
      ts: "2026-06-11T09:00:00.000Z",
    });

    const legacyDeliverable = path.join(legacyWiki, "outputs", "deliverable-001.md");
    const executorPrompt = await buildExecutorJobPrompt(
      path.resolve("."),
      cpbRoot,
      project,
      jobId,
      legacyDeliverable,
      { hubRoot },
    );
    assert.match(executorPrompt, new RegExp(escapeRegExp(path.join(dataRoot, "events", project, `${jobId}.jsonl`))));
    assert.match(executorPrompt, new RegExp(escapeRegExp(path.join(dataRoot, "wiki", "outputs", "deliverable-001.md"))));
    assert.match(executorPrompt, /\/runtime\/context-pack\.json/);
    assert.doesNotMatch(executorPrompt, new RegExp(escapeRegExp(process.env.CPB_PROJECT_RUNTIME_ROOT)));
    assert.doesNotMatch(executorPrompt, /legacy task|\/legacy\/context-pack\.json/);
    assert.doesNotMatch(executorPrompt, new RegExp(escapeRegExp(path.join(cpbRoot, "cpb-task"))));
    assert.doesNotMatch(executorPrompt, new RegExp(escapeRegExp(legacyWiki)));

    const verifierPrompt = await buildVerifierJobPrompt(
      path.resolve("."),
      cpbRoot,
      project,
      jobId,
      path.join(legacyWiki, "outputs", "verdict-001.json"),
      { hubRoot },
    );
    assert.match(verifierPrompt, new RegExp(escapeRegExp(path.join(dataRoot, "events", project, `${jobId}.jsonl`))));
    assert.match(verifierPrompt, new RegExp(escapeRegExp(path.join(dataRoot, "wiki", "outputs", "verdict-001.json"))));
    assert.doesNotMatch(verifierPrompt, new RegExp(escapeRegExp(legacyWiki)));

    await assert.rejects(
      () => buildExecutorJobPrompt(path.resolve("."), cpbRoot, "missing", jobId, legacyDeliverable, { hubRoot }),
      /project runtime root required/,
    );
  } finally {
    if (previousHubRoot === undefined) {
      delete process.env.CPB_HUB_ROOT;
    } else {
      process.env.CPB_HUB_ROOT = previousHubRoot;
    }
    if (previousProjectRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousProjectRuntimeRoot;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("permission policy uses project dataRoot and records denials without legacy fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-permission-runtime-"));
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "hub", "projects", "flow");
  const project = "flow";
  const jobId = "job-20260611-091000-runtime";

  try {
    const runtimeOutput = path.join(dataRoot, "wiki", "outputs", "verdict-001.json");
    const legacyOutput = path.join(cpbRoot, "wiki", "projects", project, "outputs", "verdict-001.json");

    assert.equal(canWrite("verifier", runtimeOutput, cpbRoot, project, null, { dataRoot }).allowed, true);
    assert.equal(canWrite("verifier", legacyOutput, cpbRoot, project, null).allowed, false);
    assert.equal(canWrite("verifier", legacyOutput, cpbRoot, project, null, { legacyOnly: true }).allowed, true);

    const policy = getPhasePolicy("verifier", cpbRoot, project, { dataRoot });
    assert.deepEqual(policy.writeAllowed, [path.join(dataRoot, "wiki", "outputs")]);
    assert.ok(policy.observablePaths.includes(path.join(dataRoot, "events", project)));
    assert.ok(policy.observablePaths.includes(path.join(dataRoot, "state")));
    assert.equal(policy.observablePaths.some((p) => p.includes(path.join(cpbRoot, "cpb-task"))), false);
    assert.equal(policy.observablePaths.some((p) => p.includes(path.join(cpbRoot, "wiki", "projects"))), false);

    const failClosedPolicy = getPhasePolicy("verifier", cpbRoot, project);
    assert.deepEqual(failClosedPolicy.writeAllowed, []);
    assert.equal(failClosedPolicy.observablePaths.some((p) => p.includes(path.join(cpbRoot, "cpb-task"))), false);
    assert.equal(failClosedPolicy.observablePaths.some((p) => p.includes(path.join(cpbRoot, "wiki", "projects"))), false);

    await recordPermissionDenial(cpbRoot, project, jobId, {
      role: "verifier",
      action: "write",
      targetPath: runtimeOutput,
      reason: "test denial",
      dataRoot,
    });
    const events = await readEvents(cpbRoot, project, jobId, { dataRoot, includeLegacyFallback: false });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "permission_denied");
    await assert.rejects(
      () => readEvents(cpbRoot, project, jobId, { includeLegacyFallback: false }),
      /dataRoot is required/,
    );

    await assert.rejects(
      () => recordPermissionDenial(cpbRoot, project, jobId, {
        role: "verifier",
        action: "write",
        targetPath: runtimeOutput,
      }),
      /project runtime root required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
