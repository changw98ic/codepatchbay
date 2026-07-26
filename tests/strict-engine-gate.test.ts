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
const runJobPortEvolutionFiles = [
  "core/engine/run-job-ports.ts",
  "core/engine/run-job-prepare.ts",
  "core/engine/run-job-assurance.ts",
  "core/engine/run-job-checklist-dag.ts",
  "core/engine/run-job-execute-dag.ts",
  "core/engine/run-job-lifecycle.ts",
];

function sliceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `source must contain start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `source must contain end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex + end.length);
}

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
    "core/engine/run-job-ports.ts",
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

test("stabilization baseline latest checkpoint reflects current job-local env closure", async () => {
  const doc = await readFile(stabilizationBaselineDoc, "utf8");
  const latestCheckpoint = doc.split("## Remediation Checkpoint 40")[1] || "";
  const runJobLines = (await readFile(path.join(repoRoot, "core", "engine", "run-job.ts"), "utf8"))
    .trimEnd()
    .split("\n")
    .length;

  assert.ok(latestCheckpoint, "stabilization baseline must include the latest job-local env checkpoint");
  assert.match(latestCheckpoint, /\| strict-engine legacy exclusions \| 0 \|/);
  assert.match(latestCheckpoint, new RegExp(`\\| \`core/engine/run-job\\.ts\` line count \\| ${runJobLines} \\|`));
  assert.match(latestCheckpoint, /\| type-debt allowlist entries \| 0 \|/);
  assert.doesNotMatch(latestCheckpoint, /strict mode still excludes `run-job\.ts`/);
});

test("runJob port evolution keeps contexts explicit instead of LooseRecord intersections", async () => {
  for (const relative of runJobPortEvolutionFiles) {
    const source = await readFile(path.join(repoRoot, relative), "utf8");
    assert.doesNotMatch(
      source,
      /type\s+\w*Context\s*=\s*LooseRecord\s*&/,
      `${relative} must declare exact context fields instead of falling back to LooseRecord &`,
    );
    assert.doesNotMatch(
      source,
      /type\s+RunJobContext\s*=\s*LooseRecord\s*&/,
      `${relative} must keep the top-level RunJobContext exact after port migration`,
    );
    assert.doesNotMatch(
      source,
      /import\s+type\s+\{[^}]*RunJobContext[^}]*\}/,
      `${relative} must not import the top-level RunJobContext into helper modules`,
    );
  }
});

test("runJob checklist decomposition explicitly carries the current job id", async () => {
  const source = await readFile(path.join(repoRoot, "core", "engine", "run-job-checklist-dag.ts"), "utf8");
  const call = sliceBetween(
    source,
    "const decomposition = await decomposeTaskToChecklistItems({",
    "});",
  );

  assert.match(call, /ctx:\s*\{/);
  assert.doesNotMatch(
    call,
    /ctx:\s*\{\s*\.\.\.ctx,\s*sourceContext:\s*phaseSourceContext\s*\}/,
    "checklist decomposition must not pass only ...ctx plus sourceContext",
  );
  assert.match(
    call,
    /jobId,\s*(?:\n|\r\n)/,
    "checklist decomposition ctx must explicitly pass the current jobId",
  );
});

test("runJob phase execution explicitly forwards runtime-only fields to runPhase", async () => {
  const source = await readFile(path.join(repoRoot, "core", "engine", "run-job-execute-dag.ts"), "utf8");
  const call = sliceBetween(
    source,
    "result ||= await runPhase({",
    "});",
  );

  for (const field of [
    "scope: ctx.scope",
    "signal: ctx.signal",
    "processHooks: ctx.processHooks",
    "env: ctx.env",
  ]) {
    assert.ok(call.includes(field), `runPhase call must explicitly pass ${field}`);
  }

  const verifySource = await readFile(path.join(repoRoot, "core", "phases", "verify.ts"), "utf8");
  const runHardGatesSource = sliceBetween(
    verifySource,
    "async function runHardGates(",
    "function tail(",
  );
  assert.match(
    verifySource,
    /const runtimeEnv = ctx\.env \?\? process\.env;/,
    "verify must resolve the job environment once before subprocess work",
  );
  assert.match(
    verifySource,
    /runHardGates\(cwd,\s*\{\s*env:\s*runtimeEnv,\s*signal:\s*ctx\?\.signal,\s*registerChild:\s*ctx\?\.processHooks\?\.registerChild\s*\}\)/,
    "verify hard gates must consume the phase env, runtime cancellation, and child-process hooks",
  );
  assert.match(
    verifySource,
    /runChecklistProbes\(acceptanceChecklist,\s*cwd,\s*\{\s*finalWorktree:\s*verificationEvidence\.git,\s*attemptId,\s*env:\s*runtimeEnv\s*\}\)/,
    "verify deterministic checklist probes must consume the explicit job env with ambient fallback",
  );
  assert.match(runHardGatesSource, /const phaseEnv = opts\.env \?\? process\.env;/);
  for (const key of ["CPB_GATE_TIMEOUT_CHECK", "CPB_GATE_TIMEOUT_TEST", "CPB_GATE_TIMEOUT_FULL"]) {
    assert.ok(runHardGatesSource.includes(`gateTimeout("${key}"`), `verify hard gates must parse ${key}`);
  }
  assert.doesNotMatch(
    runHardGatesSource.replace("const phaseEnv = opts.env ?? process.env;", ""),
    /process\.env/,
    "verify hard gates must not read ambient process.env after resolving phaseEnv",
  );

  const runJobSource = await readFile(path.join(repoRoot, "core", "engine", "run-job.ts"), "utf8");
  assert.match(runJobSource, /ctx\.env = buildRunJobEnv\(ctx\);/);
  assert.doesNotMatch(
    runJobSource,
    /process\.env\.CPB_(?:ROOT|HUB_ROOT|PROJECT_RUNTIME_ROOT|PROJECT_PATH_OVERRIDE)\s*=/,
    "runJob must never publish per-job roots through ambient process.env",
  );
  for (const resolver of [
    "solverRepairLimit(session.ctx.env ?? process.env)",
    "verificationInfrastructureRetryLimit(session.ctx.env ?? process.env)",
    "completionGateRepairLimit(session.ctx.env ?? process.env)",
  ]) {
    assert.ok(source.includes(resolver), `runJob DAG must resolve ${resolver} from the job env`);
  }
});
