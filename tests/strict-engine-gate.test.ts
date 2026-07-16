import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const stabilizationBaselineDoc = path.join(repoRoot, "docs", "product", "cpb-stabilization-baseline-2026-06-22.md");
const legacyEngineStrictExclusions = [
];

test("strict engine gate is wired to package scripts, CI, and TypeScript", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["typecheck:strict:engine"], "tsc -p tsconfig.strict-engine.json --noEmit");

  const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /npm run typecheck:strict:engine/);
  assert.ok(
    workflow.indexOf("npm run typecheck:strict:engine") > workflow.indexOf("npm run typecheck:node"),
    "strict-engine gate should run after the normal node typecheck",
  );

  const tsconfig = JSON.parse(await readFile(path.join(repoRoot, "tsconfig.strict-engine.json"), "utf8"));
  assert.equal(tsconfig.compilerOptions.strict, true);
  const expectedStrictEngineIncludes = [
    "core/engine/adversarial-verdict-events.ts",
    "core/engine/candidate-artifact.ts",
    "core/engine/candidate-replay.ts",
    "core/engine/completion-checklist-artifacts.ts",
    "core/engine/completion-gate.ts",
    "core/engine/completion-failure.ts",
    "core/engine/completion-gate-runner.ts",
    "core/engine/completion-success.ts",
    "core/engine/dag-builder.ts",
    "core/engine/dag-node-resume.ts",
    "core/engine/dag-node-lifecycle-events.ts",
    "core/engine/dag-node-failure.ts",
    "core/engine/phase-policy.ts",
    "core/engine/phase-agent-routing.ts",
    "core/engine/phase-artifact-tracker.ts",
    "core/engine/phase-retry.ts",
    "core/engine/run-job-assurance.ts",
    "core/engine/run-job-checklist-dag.ts",
    "core/engine/run-job-execute-dag.ts",
    "core/engine/run-job-planning.ts",
    "core/engine/run-job.ts",
    "core/engine/run-job-lifecycle.ts",
    "core/engine/run-job-prepare.ts",
    "core/engine/run-job-shared.ts",
    "core/engine/run-phase.ts",
    "core/engine/phase-result-events.ts",
    "core/engine/phase-start-events.ts",
    "core/engine/phase-finalize-events.ts",
    "core/engine/poisoned-session.ts",
    "core/engine/poisoned-session-gate.ts",
    "core/engine/provider-handoff.ts",
    "core/engine/provider-preflight.ts",
    "core/engine/provider-quota-fallback.ts",
    "core/engine/provider-usage-recorder.ts",
    "core/engine/runtime-artifact-events.ts",
    "core/engine/runtime-failure-recorder.ts",
    "core/engine/scope-guard.ts",
    "core/engine/scope-guard-runner.ts",
    "core/engine/session-pin.ts",
    "core/engine/solver-loop.ts",
    "core/engine/workflow-runner.ts",
    "core/workflow/acceptance-checklist.ts",
  ];
  assert.deepEqual(tsconfig.include, expectedStrictEngineIncludes);

  const engineFiles = (await readdir(path.join(repoRoot, "core", "engine")))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `core/engine/${file}`)
    .sort();
  const strictEngineFiles = new Set(tsconfig.include.filter((file: string) => file.startsWith("core/engine/")));
  const allowedLegacy = new Set(legacyEngineStrictExclusions);
  const missingStrictCoverage = engineFiles.filter((file) => !strictEngineFiles.has(file) && !allowedLegacy.has(file));
  assert.deepEqual(missingStrictCoverage, [], "new engine modules must be strict-checked or explicitly listed as legacy exclusions");

  await execFileAsync("npm", ["run", "typecheck:strict:engine"], { cwd: repoRoot });
});

test("stabilization baseline latest checkpoint reflects current strict engine closure", async () => {
  const doc = await readFile(stabilizationBaselineDoc, "utf8");
  const latestCheckpoint = doc.split("## Remediation Checkpoint 35")[1] || "";
  const runJobLines = (await readFile(path.join(repoRoot, "core", "engine", "run-job.ts"), "utf8"))
    .trimEnd()
    .split("\n")
    .length;

  assert.ok(latestCheckpoint, "stabilization baseline must include the latest strict-closure checkpoint");
  assert.match(latestCheckpoint, /\| strict-engine legacy exclusions \| 0 \|/);
  assert.match(latestCheckpoint, new RegExp(`\\| \`core/engine/run-job\\.ts\` line count \\| ${runJobLines} \\|`));
  assert.match(latestCheckpoint, /\| type-debt allowlist entries \| 0 \|/);
  assert.doesNotMatch(latestCheckpoint, /strict mode still excludes `run-job\.ts`/);
});
