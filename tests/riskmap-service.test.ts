// @ts-nocheck
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { FailureKind, isValidFailureKind } from "../core/contracts/failure.js";
import { materializeJob } from "../server/services/event-store.js";
import { enqueue, listQueue } from "../server/services/hub-queue.js";
import { tempRoot } from "./helpers.js";

const RISKMAP_MODULE_CANDIDATES = [
  "../server/services/riskmap-service.js",
  "../core/riskmap/index.js",
  "../core/riskmap/riskmap-service.js",
];

async function loadRiskMapApi() {
  const failures = [];
  for (const specifier of RISKMAP_MODULE_CANDIDATES) {
    try {
      const mod = await import(specifier);
      if (typeof mod.prepareTask === "function") return { ...mod, __specifier: specifier };
      failures.push(`${specifier}: missing prepareTask export`);
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND") failures.push(`${specifier}: ${err.message}`);
      else failures.push(`${specifier}: module not found`);
    }
  }
  assert.fail(`RiskMap service API not found. Tried: ${failures.join("; ")}`);
}

async function makeCodegraphReadyProject() {
  const sourcePath = await tempRoot("cpb-riskmap-source");
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), Buffer.alloc(8192, 1));
  await writeFile(
    path.join(sourcePath, ".codegraph", "daemon.pid"),
    `${JSON.stringify({ pid: process.pid, version: "test", socketPath: path.join(sourcePath, ".codegraph", "daemon.sock") }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(sourcePath, "README.md"), "# RiskMap fixture\n", "utf8");
  return sourcePath;
}

function highConfidenceCapabilityContext() {
  const projectCapabilityMap = {
    confidence: "high",
    coreModules: ["server/orchestrator/scheduler.js", "server/services/provider-quota.js"],
    testSurfaces: ["tests/scheduler-dag-provider.test.js", "tests/engine-provider-event.test.js"],
  };
  const safetyBoundaryMap = {
    confidence: "high",
    boundaries: ["subprocess", "github_write", "provider_pool"],
  };
  const highRiskAreaMap = {
    confidence: "high",
    areas: [
      { domain: "scheduler", files: ["server/orchestrator/scheduler.js"] },
      { domain: "provider_pool", files: ["server/services/provider-quota.js"] },
      { domain: "worktree", files: ["runtime/git/worktree.js"] },
    ],
  };
  return {
    projectCapabilityMap,
    project_capability_map: projectCapabilityMap,
    safetyBoundaryMap,
    safety_boundary_map: safetyBoundaryMap,
    highRiskAreaMap,
    high_risk_area_map: highRiskAreaMap,
  };
}

async function callPrepareTask(api, overrides = {}) {
  const cpbRoot = overrides.cpbRoot || await tempRoot("cpb-riskmap-cpb");
  const sourcePath = overrides.sourcePath === undefined
    ? await makeCodegraphReadyProject()
    : overrides.sourcePath;
  const options = {
    hubRoot: overrides.hubRoot || await tempRoot("cpb-riskmap-hub"),
    project: "flow",
    task: "Refactor scheduler provider pool concurrency and worktree recovery handling",
    jobId: "job-riskmap",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: highConfidenceCapabilityContext(),
    ...overrides,
  };
  return api.prepareTask.length >= 2
    ? api.prepareTask(cpbRoot, options)
    : api.prepareTask({ cpbRoot, ...options });
}

function normalizeRiskMap(result) {
  return result?.riskMap || result?.riskmap || result;
}

async function assertPrepareBlocks(api, overrides, expectedKind) {
  try {
    await callPrepareTask(api, overrides);
  } catch (err) {
    const kind = err?.kind || err?.failure?.kind || err?.code;
    assert.equal(kind, expectedKind);
    assert.ok(isValidFailureKind(kind), `${kind} should be a current FailureKind`);
    return err;
  }
  assert.fail(`prepareTask should block with ${expectedKind}`);
}

test("prepareTask blocks with codegraph_unavailable when sourcePath is missing", async () => {
  const api = await loadRiskMapApi();

  await assertPrepareBlocks(api, { sourcePath: null }, FailureKind.CODEGRAPH_UNAVAILABLE);
});

test("prepareTask blocks with codegraph_unavailable when CodeGraph data is unavailable", async () => {
  const api = await loadRiskMapApi();
  const sourcePath = await tempRoot("cpb-riskmap-no-codegraph");

  await assertPrepareBlocks(api, { sourcePath }, FailureKind.CODEGRAPH_UNAVAILABLE);
});

test("prepareTask blocks with a valid FailureKind when capability maps are unavailable", async () => {
  const api = await loadRiskMapApi();

  const err = await assertPrepareBlocks(
    api,
    { sourceContext: {} },
    FailureKind.CODEGRAPH_UNAVAILABLE,
  );
  assert.match(String(err.reason || err.message || ""), /capability|project map|CodeGraph|codegraph/i);
});

test("prepareTask returns a high-risk RiskMap for scheduler/provider/worktree tasks", async () => {
  const api = await loadRiskMapApi();

  const riskMap = normalizeRiskMap(await callPrepareTask(api));

  assert.equal(riskMap.riskLevel, "high");
  assert.ok(riskMap.domains.includes("scheduler"));
  assert.ok(riskMap.domains.includes("provider_pool"));
  assert.ok(riskMap.highRiskFiles.includes("server/orchestrator/scheduler.js"));
  assert.equal(riskMap.adversarialRequired, true);
  assert.match(riskMap.verificationDepth, /strict|paranoid/);
  assert.equal(riskMap.confidence, "high");
});

test("prepareTask returns and persists a dynamic agent plan for high-risk tasks", async () => {
  const api = await loadRiskMapApi();
  const hubRoot = await tempRoot("cpb-riskmap-dynamic-agent-hub");
  const queueEntry = await enqueue(hubRoot, {
    projectId: "flow",
    description: "Refactor scheduler provider capacity",
  });

  const result = await callPrepareTask(api, {
    hubRoot,
    sourceContext: {
      ...highConfidenceCapabilityContext(),
      queueEntryId: queueEntry.id,
    },
  });

  assert.equal(result.dynamicAgentPlan.riskLevel, "high");
  assert.equal(result.dynamicAgentPlan.agentConfig.verifier.required, true);
  assert.equal(result.dynamicAgentPlan.agentConfig.verifier.independent, true);
  assert.equal(result.dynamicAgentPlan.agentConfig.adversarial_verifier.required, true);

  const updated = (await listQueue(hubRoot)).find((entry) => entry.id === queueEntry.id);
  assert.equal(updated.metadata.dynamicAgentPlan.riskLevel, "high");
  assert.equal(updated.metadata.dynamicAgentPlan.agentConfig.verifier.required, true);
});

test("prepareTask returns a low or medium RiskMap for docs-only tasks", async () => {
  const api = await loadRiskMapApi();

  const riskMap = normalizeRiskMap(await callPrepareTask(api, {
    task: "Update README wording and fix documentation typos only",
  }));

  assert.match(riskMap.riskLevel, /low|medium/);
  assert.equal(riskMap.adversarialRequired, false);
  assert.match(riskMap.verificationDepth, /standard|strict/);
  assert.equal(riskMap.confidence, "high");
});

test("materializeJob stores riskmap_generated summary and full RiskMap", () => {
  const riskMap = {
    riskLevel: "high",
    domains: ["scheduler", "provider_pool"],
    highRiskFiles: ["server/orchestrator/scheduler.js"],
    safetyBoundaries: ["subprocess"],
    verificationDepth: "strict",
    adversarialRequired: true,
    adversarialFocus: ["race conditions"],
    confidence: "high",
  };

  const job = materializeJob([
    {
      type: "riskmap_generated",
      jobId: "job-riskmap-event",
      project: "flow",
      phase: "prepare_task",
      riskMap,
      riskLevel: riskMap.riskLevel,
      verificationDepth: riskMap.verificationDepth,
      adversarialRequired: riskMap.adversarialRequired,
      ts: "2026-06-08T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(job.riskMap, riskMap);
  assert.equal(job.riskLevel, "high");
  assert.equal(job.verificationDepth, "strict");
  assert.equal(job.adversarialRequired, true);
});
