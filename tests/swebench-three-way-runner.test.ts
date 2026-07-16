import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  buildFrozenManifests,
  promptLeakageViolations,
  summarizeCandidateFreeze,
  classifySolverOutcome,
  correlateSolverAndHarnessOutcomes,
  isTransientSolverFailure,
  solverRetryDelayMs,
  isRetryableDatasetStatus,
  isTransientSourceFetchFailure,
  harnessResumeDecision,
  buildHarnessEnvironment,
  buildExecutionContract,
  buildDatasetCacheEnvelope,
  buildNativeClaudeIsolatedEnv,
  buildNativeClaudeSettings,
  buildNativeClaudeArgs,
  observedModelAttestation,
  observedModelContractViolation,
  sliceValidatedDatasetCacheEnvelope,
  validateDatasetCacheEnvelope,
  latestCandidateReplayBundle,
  parseHarnessInstanceReport,
  selectHarnessRetryIds,
  summarizeHarnessTestMetrics,
  nextHarnessAttemptNumber,
  parseRuntimeRoots,
  runtimePackageCacheDenyRoots,
  findBoundaryProbeTarget,
  discoverExecutablePackageRoots,
  runtimeConfigReadRoots,
  evaluateBoundaryProbe,
  parseClaudeRuntimeBoundaryStream,
  claudeRuntimeBoundaryRetryReason,
  assertRunNotInvalidated,
  agentLaunchContractViolation,
  independentVerificationContractViolation,
  archiveLaneAttempt,
  prepareLaneForSolverInvocation,
  parseSolverLaneConcurrency,
  runIndependentLaneQueues,
  reconcileInterruptedSolverInvocations,
  compactLaneEphemeralArtifacts,
  recoverInterruptedClaudeBoundaryPreflight,
  nextSolverAttemptNumber,
  recoverHarnessInstanceReports,
  type HarnessInstanceResult,
} from "../scripts/run-swebench-three-way.js";
import { tempRoot } from "./helpers.js";

const row = {
  instance_id: "owner__repo-123",
  repo: "owner/repo",
  base_commit: "0123456789abcdef",
  problem_statement: "Fix the cache invalidation bug for renamed keys.",
  FAIL_TO_PASS: JSON.stringify(["tests/test_cache.py::test_rename"]),
  PASS_TO_PASS: JSON.stringify(["tests/test_cache.py::test_get"]),
};

test("solver dependency roots exclude broad runtime prefixes and identify package caches", async () => {
  const prefix = path.join(await tempRoot("cpb-runtime-prefix"), "conda");
  const sitePackages = path.join(prefix, "lib", "python3.12", "site-packages");
  const parsed = parseRuntimeRoots(JSON.stringify({
    paths: [sitePackages],
    runtimePaths: [path.join(prefix, "include", "python3.12"), path.join(prefix, "bin")],
    prefixes: [prefix],
  }));

  assert.deepEqual(parsed.readRoots.sort(), [
    path.join(prefix, "bin"),
    path.join(prefix, "include", "python3.12"),
    path.join(prefix, "lib"),
    sitePackages,
  ].sort());
  assert.deepEqual(parsed.prefixes, [prefix]);
  assert.equal(parsed.readRoots.includes(prefix), false);
  assert.deepEqual(runtimePackageCacheDenyRoots(parsed.prefixes), [
    path.join(prefix, "conda-bld"),
    path.join(prefix, "pkgs"),
  ]);
});

test("source-boundary preflight probes a file inside denied directories", async () => {
  const root = await tempRoot("cpb-boundary-probe-target");
  const deniedPackage = path.join(root, "pkgs", "project_pkg-2.0", "site-packages", "project_pkg");
  const sentinel = path.join(deniedPackage, "__init__.py");
  await mkdir(deniedPackage, { recursive: true });
  await writeFile(sentinel, "future implementation\n", "utf8");

  assert.equal(await findBoundaryProbeTarget(deniedPackage), sentinel);
});

test("runtime tool shims expose only their package roots and never the task package", async () => {
  const root = await tempRoot("cpb-runtime-tool-shims");
  const bin = path.join(root, "bin");
  const npmRoot = path.join(root, "lib", "node_modules", "npm");
  const taskRoot = path.join(root, "lib", "node_modules", "project-pkg");
  await mkdir(path.join(npmRoot, "bin"), { recursive: true });
  await mkdir(path.join(taskRoot, "bin"), { recursive: true });
  await writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "npm" }), "utf8");
  await writeFile(path.join(taskRoot, "package.json"), JSON.stringify({ name: "project-pkg" }), "utf8");
  await writeFile(path.join(npmRoot, "bin", "npm-cli.js"), "", "utf8");
  await writeFile(path.join(taskRoot, "bin", "cli.js"), "", "utf8");
  await mkdir(bin, { recursive: true });
  await symlink(path.relative(bin, path.join(npmRoot, "bin", "npm-cli.js")), path.join(bin, "npm"));
  await symlink(path.relative(bin, path.join(taskRoot, "bin", "cli.js")), path.join(bin, "project-cli"));

  assert.deepEqual(await discoverExecutablePackageRoots([bin], ["project_pkg"]), [await realpath(npmRoot)]);
});

test("runtime config roots are exact and do not restore install prefixes", () => {
  assert.deepEqual(runtimeConfigReadRoots(["/opt/conda"], {
    OPENSSL_CONF: "/custom/ssl/openssl.cnf",
  }), [
    "/System/Library/OpenSSL",
    "/custom/ssl",
    "/opt/conda/ssl",
  ]);
});

test("source-boundary verdict accepts only permission-denied evidence", () => {
  const deniedTargets = [
    { deniedPath: "/runtime/project", target: "/runtime/project/__init__.py", kind: "file" as const },
  ];
  assert.deepEqual(evaluateBoundaryProbe({
    inside: { ok: true, code: null },
    denied: [{ target: deniedTargets[0].target, ok: false, code: "EPERM" }],
    network: { connected: false, code: "EACCES" },
  }, deniedTargets), []);
  assert.deepEqual(evaluateBoundaryProbe({
    inside: { ok: true, code: null },
    denied: [{ target: deniedTargets[0].target, ok: false, code: "ENOENT" }],
    network: { connected: false, code: "ECONNREFUSED" },
  }, deniedTargets), [
    "denied_target_not_permission_blocked:/runtime/project/__init__.py:ENOENT",
    "network_not_permission_blocked:ECONNREFUSED",
  ]);
});

test("Claude runtime boundary stream proves restricted tools, hook execution, and exact probe command", () => {
  const command = "node -e probe";
  const probe = {
    inside: { ok: true, code: null },
    denied: [{ target: "/denied/file", ok: false, code: "EPERM" }],
    network: { connected: false, code: "EACCES" },
  };
  const stdout = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      model: "glm-5.2",
      tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"],
      mcp_servers: [],
      slash_commands: [],
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "probe-1", name: "Bash", input: { command } }] },
    }),
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "PreToolUse:Bash",
      output: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "probe-1", content: JSON.stringify(probe) }] },
    }),
  ].join("\n");

  const parsed = parseClaudeRuntimeBoundaryStream(stdout, command, "glm-5.2");
  assert.deepEqual(parsed.violations, []);
  assert.deepEqual(parsed.probe, probe);
  assert.equal(parsed.hookAllowed, true);

  const changed = parseClaudeRuntimeBoundaryStream(stdout, `${command} changed`, "glm-5.2");
  assert.deepEqual(changed.violations, ["claude_bash_probe_command_changed"]);
  assert.equal(claudeRuntimeBoundaryRetryReason(changed), "model_changed_bash_probe_command");

  const refusal = parseClaudeRuntimeBoundaryStream(stdout.split("\n")[0], command, "glm-5.2");
  assert.deepEqual(refusal.violations, [
    "claude_bash_probe_missing",
    "claude_bash_probe_command_changed",
    "claude_path_guard_hook_not_observed",
  ]);
  assert.equal(claudeRuntimeBoundaryRetryReason(refusal), "model_did_not_invoke_bash_probe");
  assert.equal(
    claudeRuntimeBoundaryRetryReason(refusal, "API Error: 429 限额将在 2026-07-16 19:58:30 重置"),
    "provider_transient_failure",
  );

  const missingHook = parseClaudeRuntimeBoundaryStream([
    stdout.split("\n")[0],
    stdout.split("\n")[1],
  ].join("\n"), command, "glm-5.2");
  assert.equal(claudeRuntimeBoundaryRetryReason(missingHook), null);
});

test("invalidated runs cannot be resumed or scored", async () => {
  const root = await tempRoot("cpb-invalidated-run");
  await writeFile(path.join(root, "INVALIDATED.json"), JSON.stringify({ reason: "source_boundary_leak" }), "utf8");
  await assert.rejects(
    () => assertRunNotInvalidated(root),
    /permanently invalidated \(source_boundary_leak\)/,
  );
});

test("three-way manifests keep evaluator identity and oracle tests out of the solver projection", () => {
  const manifests = buildFrozenManifests([{ rowIndex: 7, row }], "comparison-run");
  const solverJson = JSON.stringify(manifests.solver);
  const evaluatorJson = JSON.stringify(manifests.evaluator);

  assert.match(solverJson, /Fix the cache invalidation bug/);
  assert.match(solverJson, /owner\/repo/);
  assert.doesNotMatch(solverJson, /owner__repo-123|FAIL_TO_PASS|PASS_TO_PASS|test_rename|test_get/);
  assert.match(evaluatorJson, /owner__repo-123|test_rename|test_get/);
  assert.equal(manifests.evaluator.solverManifestSha256, manifests.solver.manifestSha256);
  assert.match(manifests.solver.tasks[0].opaqueId, /^task-[a-f0-9]{16}$/);
});

test("prompt leakage gate catches benchmark identity and evaluator contracts", () => {
  assert.deepEqual(promptLeakageViolations("Fix the cache invalidation bug.", "owner__repo-123"), []);
  const violations = promptLeakageViolations(
    "Run SWE-bench owner__repo-123 FAIL_TO_PASS with the official harness and gold patch.",
    "owner__repo-123",
  );
  assert.deepEqual(violations.sort(), [
    "benchmark_name",
    "fail_to_pass",
    "gold_patch",
    "instance_id",
    "official_harness",
  ]);
});

test("official scoring accepts frozen solver failures but rejects leakage or missing candidates", () => {
  const frozenFailure = {
    lane: "cpb_high_assurance" as const,
    opaqueId: "task-a",
    status: "failed" as const,
    patchPath: "/run/task-a/candidate.patch",
    patchSha256: "a".repeat(64),
    patchBytes: 128,
    error: "independent verification environment was not executable",
    timedOut: false,
    metadata: {
      jobFailure: {
        kind: "verification_failed",
        cause: {
          verificationInfrastructure: { failureClass: "verification_infrastructure" },
        },
      },
    },
  };
  const accepted = summarizeCandidateFreeze([frozenFailure]);
  assert.equal(accepted.complete, true);
  assert.equal(accepted.solverFailures.length, 1);
  assert.equal(accepted.solverFailures[0].failureClass, "verification_infrastructure");
  assert.equal(accepted.solverOutcomeSummary.totals.verification_infrastructure, 1);

  const blocked = summarizeCandidateFreeze([{ ...frozenFailure, status: "blocked" as const }]);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.blocked.length, 1);

  const missing = summarizeCandidateFreeze([{ ...frozenFailure, patchSha256: "" }]);
  assert.equal(missing.complete, false);
  assert.equal(missing.missingArtifacts.length, 1);
});

test("solver classifications stay separate from official implementation failures", () => {
  const base = {
    lane: "cpb_high_assurance" as const,
    opaqueId: "task-a",
    status: "failed" as const,
    timedOut: false,
    error: null,
  };
  const verificationInfrastructure = {
    ...base,
    metadata: {
      jobFailure: {
        kind: "verification_failed",
        cause: { verificationInfrastructure: { failureClass: "verification_infrastructure" } },
      },
    },
  };
  assert.equal(classifySolverOutcome(verificationInfrastructure), "verification_infrastructure");
  assert.equal(classifySolverOutcome({
    ...base,
    metadata: { jobFailure: { kind: "verification_failed", cause: {} } },
  }), "semantic_verification_failure");
  assert.equal(classifySolverOutcome({
    ...base,
    metadata: { jobFailure: { kind: "scope_violation", cause: {} } },
  }), "workflow_policy_failure");

  const correlation = correlateSolverAndHarnessOutcomes(
    [verificationInfrastructure],
    [{ opaqueId: "task-a", instanceId: "owner__repo-123" }],
    [{
      lane: "cpb_high_assurance",
      resolvedIds: ["owner__repo-123"],
      unresolvedIds: [],
      errorIds: [],
    }],
  );
  assert.equal(
    correlation.totals["verification_infrastructure->official_resolved"],
    1,
  );
  assert.deepEqual(correlation.internalFalseNegatives, [{
    lane: "cpb_high_assurance",
    opaqueId: "task-a",
    instanceId: "owner__repo-123",
  }]);
});

test("solver retries are limited to transient infrastructure and provider failures", () => {
  const base = { status: "failed" as const, timedOut: false, error: null, metadata: {} };
  assert.equal(isTransientSolverFailure({ ...base, error: "529 overloaded after retry budget" }), true);
  assert.equal(isTransientSolverFailure({ ...base, error: "stream disconnected before completion" }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "codex exited null: ",
    metadata: { jobFailure: { kind: "agent_unavailable", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "runtime_interrupted", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "runtime_interrupted", retryable: false } },
  }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "unknown", retryable: true } },
  }, "timeout while unrelated lease monitor was stopping"), false);
  assert.equal(isTransientSolverFailure({ ...base, timedOut: true }), true);
  assert.equal(isTransientSolverFailure({ ...base, error: "verification failed: assertion mismatch" }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "verification failed: assertion mismatch",
    metadata: { jobFailure: { kind: "verification_failed", retryable: true } },
  }, "worker execution lease renewal temporarily unavailable"), false);
  assert.equal(isTransientSolverFailure({ ...base, status: "blocked" as const, error: "529" }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "agent contract invalid",
    metadata: { idleTimeoutMs: 120000, jobFailure: { kind: "agent_contract_invalid" } },
  }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "generated checklist contract invalid",
    metadata: { jobFailure: { kind: "artifact_invalid", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "planner exceeded its bounded discovery budget",
    metadata: { jobFailure: { kind: "tool_budget_exceeded", retryable: true } },
  }), true);
  assert.equal(isTransientSolverFailure({
    ...base,
    error: "planner exceeded its bounded discovery budget",
    metadata: { jobFailure: { kind: "tool_budget_exceeded", retryable: false } },
  }), false);
  assert.equal(isTransientSolverFailure({
    ...base,
    metadata: { jobFailure: { kind: "human_approval_required", retryable: false } },
  }, "worker lease renewal temporarily unavailable"), false);
});

test("solver retry delay honors provider reset timestamps instead of burning the queue", () => {
  const nowMs = Date.parse("2026-07-16T11:00:00.000Z");
  assert.equal(solverRetryDelayMs({ error: null, metadata: {} }, "529 overloaded", 10_000, nowMs), 10_000);
  assert.equal(solverRetryDelayMs({
    error: null,
    metadata: {
      jobFailure: {
        reason: "provider claude:glm unavailable until 2026-07-16T11:58:30.000Z",
      },
    },
  }, "", 10_000, nowMs), 3_511_000);

  const localNowMs = new Date(2026, 6, 16, 19, 0, 0).getTime();
  assert.equal(solverRetryDelayMs(
    { error: null, metadata: {} },
    "[1308][已达到 5 小时的使用上限。您的限额将在 2026-07-16 19:58:30 重置。]",
    10_000,
    localNowMs,
  ), 3_511_000);
});

test("solver attempt history is append-only across resumed invocations", async () => {
  const runRoot = await tempRoot("cpb-solver-attempt-history");
  const lane = "cpb_high_assurance" as const;
  const opaqueId = "task-resume-safe";
  const laneRoot = path.join(runRoot, "lanes", lane, opaqueId);
  const writeFailedAttempt = async (marker: string) => {
    const stdoutPath = path.join(laneRoot, "stdout.log");
    const stderrPath = path.join(laneRoot, "stderr.log");
    const patchPath = path.join(laneRoot, "candidate.patch");
    const eventPath = path.join(laneRoot, "trace", "events.jsonl");
    await mkdir(path.dirname(eventPath), { recursive: true });
    await writeFile(stdoutPath, `${marker}-stdout\n`, "utf8");
    await writeFile(stderrPath, `${marker}-stderr\n`, "utf8");
    await writeFile(patchPath, "", "utf8");
    await writeFile(eventPath, `${marker}-event\n`, "utf8");
    const result = {
      lane,
      opaqueId,
      status: "failed" as const,
      startedAt: "2026-07-15T00:00:00.000Z",
      completedAt: "2026-07-15T00:01:00.000Z",
      sourcePath: path.join(laneRoot, "source"),
      patchPath,
      patchSha256: createHash("sha256").update("").digest("hex"),
      patchBytes: 0,
      exitCode: 0,
      signal: null,
      timedOut: false,
      error: `${marker}-failure`,
      promptLeakage: [],
      stdoutPath,
      stderrPath,
      metadata: {
        eventPath,
        jobFailure: {
          kind: "agent_contract_invalid",
          phase: "assurance_plan",
          reason: `${marker}-budget-exceeded`,
          retryable: true,
        },
      },
    };
    await writeFile(path.join(laneRoot, "result.json"), JSON.stringify(result), "utf8");
    await writeFile(path.join(laneRoot, "state.json"), JSON.stringify(result), "utf8");
    return result;
  };

  assert.equal(nextSolverAttemptNumber(["index.json", "attempt-001", "attempt-009"]), 10);
  const first = await archiveLaneAttempt(
    await writeFailedAttempt("first"),
    1,
    { runRoot, solverRetryBackoffMs: 10 },
    "invocation-a",
  );
  const second = await archiveLaneAttempt(
    await writeFailedAttempt("second"),
    1,
    { runRoot, solverRetryBackoffMs: 10 },
    "invocation-b",
  );

  assert.equal(first.historyAttempt, 1);
  assert.equal(second.historyAttempt, 2);
  const historyRoot = path.join(runRoot, "attempt-history", lane, opaqueId);
  assert.equal(await readFile(path.join(historyRoot, "attempt-001", "stdout.log"), "utf8"), "first-stdout\n");
  assert.equal(await readFile(path.join(historyRoot, "attempt-002", "stdout.log"), "utf8"), "second-stdout\n");
  const firstRecord = JSON.parse(await readFile(path.join(historyRoot, "attempt-001", "archive-record.json"), "utf8"));
  assert.equal(firstRecord.invocationId, "invocation-a");
  assert.equal(firstRecord.decision, "retry_transient_failure");
  assert.equal(firstRecord.artifacts.some((artifact: { path: string }) => artifact.path.endsWith("trace/events.jsonl")), true);
  assert.equal(firstRecord.pathRelocations.some((entry: { archivedPath: string }) => entry.archivedPath.includes("attempt-001")), true);
  const index = JSON.parse(await readFile(path.join(historyRoot, "index.json"), "utf8"));
  assert.deepEqual(index.attempts.map((attempt: { historyAttempt: number }) => attempt.historyAttempt), [1, 2]);
  assert.deepEqual(index.attempts.map((attempt: { invocationId: string }) => attempt.invocationId), ["invocation-a", "invocation-b"]);
});

test("solver resume archives an interrupted lane before starting clean", async () => {
  const runRoot = await tempRoot("cpb-solver-interrupted-lane");
  const lane = "native_codex" as const;
  const opaqueId = "task-interrupted";
  const laneRoot = path.join(runRoot, "lanes", lane, opaqueId);
  await mkdir(laneRoot, { recursive: true });
  await writeFile(path.join(laneRoot, "stdout.log"), "partial trace\n", "utf8");

  const existing = await prepareLaneForSolverInvocation(
    lane,
    opaqueId,
    { runRoot, solverRetryBackoffMs: 10 },
    "invocation-resume",
  );

  assert.equal(existing, null);
  const archiveRoot = path.join(runRoot, "attempt-history", lane, opaqueId, "attempt-001");
  assert.equal(await readFile(path.join(archiveRoot, "stdout.log"), "utf8"), "partial trace\n");
  const record = JSON.parse(await readFile(path.join(archiveRoot, "archive-record.json"), "utf8"));
  assert.equal(record.decision, "resume_interrupted_attempt");
  assert.equal(record.result, null);
});

test("solver lane concurrency is explicit, bounded, and defaults independently", () => {
  assert.deepEqual(parseSolverLaneConcurrency(null), {
    native_codex: 1,
    native_claude_glm: 1,
    cpb_high_assurance: 1,
  });
  assert.deepEqual(parseSolverLaneConcurrency("2"), {
    native_codex: 2,
    native_claude_glm: 2,
    cpb_high_assurance: 2,
  });
  assert.deepEqual(parseSolverLaneConcurrency("native_codex=2,cpb_high_assurance=3"), {
    native_codex: 2,
    native_claude_glm: 1,
    cpb_high_assurance: 3,
  });
  assert.throws(() => parseSolverLaneConcurrency("native_codex=0"), /at least 1/);
  assert.throws(() => parseSolverLaneConcurrency("unknown=2"), /unknown lane/);
  assert.throws(() => parseSolverLaneConcurrency("native_codex=2,native_codex=3"), /repeats lane/);
});

test("solver lanes advance independently without a per-task barrier", async () => {
  let releaseSlowLane = () => {};
  const slowLaneGate = new Promise<void>((resolve) => { releaseSlowLane = resolve; });
  const completions: string[] = [];
  const output = await runIndependentLaneQueues({
    lanes: ["native_codex", "native_claude_glm", "cpb_high_assurance"],
    taskCount: 3,
    laneConcurrency: {
      native_codex: 2,
      native_claude_glm: 1,
      cpb_high_assurance: 1,
    },
    run: async (lane, taskIndex) => {
      if (lane === "cpb_high_assurance" && taskIndex === 0) await slowLaneGate;
      await new Promise<void>((resolve) => setImmediate(resolve));
      completions.push(`${lane}:${taskIndex}`);
      if (lane === "native_codex" && taskIndex === 2) releaseSlowLane();
      return `${lane}:${taskIndex}`;
    },
  });

  assert.equal(completions.indexOf("native_codex:2") < completions.indexOf("cpb_high_assurance:0"), true);
  assert.deepEqual(output.map((entry) => entry.value), [
    "native_codex:0", "native_claude_glm:0", "cpb_high_assurance:0",
    "native_codex:1", "native_claude_glm:1", "cpb_high_assurance:1",
    "native_codex:2", "native_claude_glm:2", "cpb_high_assurance:2",
  ]);
});

test("solver invocation recovery marks dead owners interrupted and rejects live owners", async () => {
  const runRoot = await tempRoot("cpb-solver-invocation-recovery");
  const invocationRoot = path.join(runRoot, "solver-invocations");
  await mkdir(invocationRoot, { recursive: true });
  await writeFile(path.join(invocationRoot, "dead.json"), JSON.stringify({
    invocationId: "dead",
    status: "running",
    host: "test-host",
    pid: 100,
  }), "utf8");

  assert.deepEqual(await reconcileInterruptedSolverInvocations(runRoot, {
    currentPid: 200,
    currentHost: "test-host",
    isPidAlive: () => false,
  }), ["dead"]);
  const recovered = JSON.parse(await readFile(path.join(invocationRoot, "dead.json"), "utf8"));
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.interruptionReason, "owner_process_missing");

  await writeFile(path.join(invocationRoot, "live.json"), JSON.stringify({
    invocationId: "live",
    status: "running",
    host: "test-host",
    pid: 300,
  }), "utf8");
  await assert.rejects(() => reconcileInterruptedSolverInvocations(runRoot, {
    currentPid: 200,
    currentHost: "test-host",
    isPidAlive: (pid) => pid === 300,
  }), /solver invocation already active: live/);
});

test("frozen lane compaction removes only rebuildable state and preserves diff and trace evidence", async () => {
  const runRoot = await tempRoot("cpb-solver-lane-compaction");
  const laneRoot = path.join(runRoot, "lanes", "cpb_high_assurance", "task-a");
  const projectRoot = path.join(laneRoot, "hub", "projects", "project-a");
  const preserved = [
    path.join(laneRoot, "candidate.patch"),
    path.join(laneRoot, "stdout.log"),
    path.join(projectRoot, "events", "job.jsonl"),
    path.join(projectRoot, "acp-streams", "execute.jsonl"),
  ];
  const removed = [
    path.join(laneRoot, "source", "large-build.bin"),
    path.join(laneRoot, "tmp", "scratch"),
    path.join(laneRoot, "agent-homes", "native", "cache"),
    path.join(laneRoot, "hub", "worktrees", "job-a", "checkout"),
    path.join(projectRoot, "agent-homes", "codex", "cache"),
  ];
  for (const file of [...preserved, ...removed]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, path.basename(file), "utf8");
  }

  const record = await compactLaneEphemeralArtifacts(laneRoot, runRoot);
  for (const file of preserved) assert.equal(await readFile(file, "utf8"), path.basename(file));
  for (const file of removed) await assert.rejects(() => readFile(file, "utf8"));
  assert.equal(record.removed.some((entry) => entry.endsWith("/source")), true);
  assert.equal(record.removed.some((entry) => entry.endsWith("/hub/worktrees")), true);
  assert.equal(record.preserved.some((entry) => entry.endsWith("/candidate.patch")), true);
  const persisted = JSON.parse(await readFile(path.join(laneRoot, "artifact-retention.json"), "utf8"));
  assert.deepEqual(persisted.removed, record.removed);

  await assert.rejects(
    () => compactLaneEphemeralArtifacts(runRoot, runRoot),
    /outside the run lanes root/,
  );
});

test("interrupted Claude boundary preflight is append-only archived before a clean retry", async () => {
  const runRoot = await tempRoot("cpb-claude-preflight-recovery");
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  const partialLog = path.join(preflightRoot, "attempts", "attempt-001", "stdout.log");
  await mkdir(path.dirname(partialLog), { recursive: true });
  await writeFile(partialLog, "partial boundary stream\n", "utf8");
  await writeFile(path.join(preflightRoot, "owner.json"), JSON.stringify({
    host: "test-host",
    pid: 100,
  }), "utf8");

  const recovered = await recoverInterruptedClaudeBoundaryPreflight(runRoot, {
    currentHost: "test-host",
    currentPid: 200,
    isPidAlive: () => false,
  });
  assert.equal(recovered?.decision, "resume_interrupted_preflight");
  const archiveRoot = path.join(runRoot, "preflight", "claude-runtime-boundary-history", "attempt-001");
  assert.equal(await readFile(path.join(archiveRoot, "attempts", "attempt-001", "stdout.log"), "utf8"), "partial boundary stream\n");
  assert.equal(JSON.parse(await readFile(path.join(archiveRoot, "recovery-record.json"), "utf8")).historyAttempt, 1);
  await assert.rejects(() => readFile(partialLog, "utf8"));

  await mkdir(preflightRoot, { recursive: true });
  await writeFile(path.join(preflightRoot, "owner.json"), JSON.stringify({
    host: "test-host",
    pid: 300,
  }), "utf8");
  await assert.rejects(() => recoverInterruptedClaudeBoundaryPreflight(runRoot, {
    currentHost: "test-host",
    currentPid: 200,
    isPidAlive: (pid) => pid === 300,
  }), /preflight already active/);
});

test("CPB comparison lane owns the quota delegate lifecycle", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "..", "..", "scripts", "run-swebench-three-way.ts"), "utf8");
  assert.match(source, /startQuotaDelegate\(assignment\.hubRoot, laneRoot, frozenDistRoot\)/);
  assert.match(source, /finally\s*\{\s*await stopQuotaDelegate\(\);\s*\}/);
  assert.match(source, /isDelegateAlive\(hubRoot\)/);
});

test("dataset manifest fetch retries only transient HTTP classes", () => {
  assert.equal(isRetryableDatasetStatus(null), true);
  assert.equal(isRetryableDatasetStatus(408), true);
  assert.equal(isRetryableDatasetStatus(429), true);
  assert.equal(isRetryableDatasetStatus(502), true);
  assert.equal(isRetryableDatasetStatus(400), false);
  assert.equal(isRetryableDatasetStatus(404), false);
});

test("dataset slice cache is range-bound and hash-validated before reuse", () => {
  const rows = [
    { rowIndex: 7, row },
    { rowIndex: 8, row: { ...row, instance_id: "owner__repo-124" } },
  ];
  const envelope = buildDatasetCacheEnvelope(rows, 7, 2, "python_datasets_offline");
  const valid = validateDatasetCacheEnvelope(envelope, { offset: 7, count: 2 });
  assert.equal(valid.ok, true);

  const tampered = structuredClone(envelope);
  tampered.rows[1].row.problem_statement = "A different task slipped into the cache.";
  assert.deepEqual(validateDatasetCacheEnvelope(tampered, { offset: 7, count: 2 }), {
    ok: false,
    reason: "cache_hash_mismatch",
  });
  assert.deepEqual(validateDatasetCacheEnvelope(envelope, { offset: 0, count: 2 }), {
    ok: false,
    reason: "cache_metadata_mismatch",
  });

  const sliced = sliceValidatedDatasetCacheEnvelope(envelope, { offset: 8, count: 1 });
  assert.equal(sliced.ok, true);
  if (sliced.ok) {
    assert.equal(sliced.envelope.offset, 8);
    assert.equal(sliced.envelope.count, 1);
    assert.equal(sliced.envelope.rows[0]?.rowIndex, 8);
    assert.equal(validateDatasetCacheEnvelope(sliced.envelope, { offset: 8, count: 1 }).ok, true);
  }
  assert.deepEqual(sliceValidatedDatasetCacheEnvelope(envelope, { offset: 9, count: 1 }), {
    ok: false,
    reason: "source_cache_does_not_contain_range",
  });

  const corruptSource = structuredClone(envelope);
  corruptSource.rows[0].row.problem_statement = "tampered before slicing";
  assert.deepEqual(sliceValidatedDatasetCacheEnvelope(corruptSource, { offset: 7, count: 1 }), {
    ok: false,
    reason: "source_cache_hash_mismatch",
  });
});

test("source preparation retries transport failures but not invalid commits", () => {
  assert.equal(isTransientSourceFetchFailure("LibreSSL SSL_connect: SSL_ERROR_SYSCALL"), true);
  assert.equal(isTransientSourceFetchFailure("RPC failed; curl 92 HTTP/2 stream was not closed cleanly"), true);
  assert.equal(isTransientSourceFetchFailure("fatal: couldn't find remote ref not-a-commit"), false);
  assert.equal(isTransientSolverFailure({
    status: "failed",
    timedOut: false,
    error: "source preparation failed: SSL_ERROR_SYSCALL",
    metadata: { failureStage: "source_prepare" },
  }), true);
  assert.equal(isTransientSolverFailure({
    status: "failed",
    timedOut: false,
    error: "source preparation failed: couldn't find remote ref deadbeef",
    metadata: { failureStage: "source_prepare" },
  }), false);
});

test("source preparation uses a run cache and verifies the exact base commit", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "..", "..", "scripts", "run-swebench-three-way.ts"), "utf8");
  assert.match(source, /path\.join\(runRoot, "source-cache"/);
  assert.match(source, /source identity mismatch/);
  assert.match(source, /source-fetch-attempts\.json/);
  assert.doesNotMatch(source, /if \(await exists\(path\.join\(sourcePath, "\.git"\)\)\) return sourcePath/);
  assert.match(source, /transientExhausted: true/);
  assert.match(source, /resume the same frozen run/);
});

test("official harness resume requires the same frozen predictions and run identity", () => {
  const expected = {
    lane: "native_codex" as const,
    runId: "comparison-native_codex",
    predictionsSha256: "a".repeat(64),
    totalInstances: 50,
  };
  const summary = {
    ...expected,
    submittedInstances: 50,
    completedInstances: 50,
    emptyPatchInstances: 0,
    errorInstances: 0,
    aggregatePath: "/run/harness/native_codex/report.json",
  };
  assert.equal(harnessResumeDecision(summary, expected).reusable, true);
  assert.deepEqual(harnessResumeDecision({ ...summary, predictionsSha256: "b".repeat(64) }, expected), {
    reusable: false,
    reason: "summary_mismatch:predictions_sha256",
  });
  assert.equal(harnessResumeDecision({ ...summary, totalInstances: 49 }, expected).reusable, false);
  assert.deepEqual(harnessResumeDecision({ ...summary, completedInstances: 49, errorInstances: 1 }, expected), {
    reusable: false,
    reason: "summary_mismatch:incomplete_or_error",
  });
  assert.equal(harnessResumeDecision({ ...summary, completedInstances: 49, emptyPatchInstances: 1 }, expected).reusable, true);
});

test("official harness retries only instances without a valid verdict report", () => {
  const resolved = { alpha: { resolved: true, tests_status: {} } };
  const unresolved = { beta: { resolved: false } };
  const corrupt = { gamma: { resolved: "yes" } };
  assert.equal(parseHarnessInstanceReport(resolved, "alpha").ok, true);
  assert.equal(parseHarnessInstanceReport(unresolved, "beta").ok, true);
  assert.equal(parseHarnessInstanceReport(corrupt, "gamma").ok, false);
  assert.deepEqual(selectHarnessRetryIds({
    requestedIds: ["alpha", "beta", "gamma", "delta", "empty"],
    aggregate: { error_ids: ["gamma", "delta"], empty_patch_ids: ["empty"] },
    reports: { alpha: resolved, beta: unresolved, gamma: corrupt, delta: null },
  }), ["gamma", "delta"]);
});

test("official harness metrics preserve per-instance FAIL_TO_PASS and PASS_TO_PASS evidence", () => {
  const metrics = summarizeHarnessTestMetrics([
    {
      instanceId: "alpha",
      resolved: true,
      reportPath: "/run/alpha/report.json",
      attempt: 1,
      testsStatus: {
        FAIL_TO_PASS: { success: ["f2p-a"], failure: [] },
        PASS_TO_PASS: { success: ["p2p-a"], failure: ["p2p-b"] },
      },
    },
    {
      instanceId: "beta",
      resolved: false,
      reportPath: "/run/beta/report.json",
      attempt: 2,
      testsStatus: null,
    },
  ]);
  assert.deepEqual(metrics.metricsAvailableIds, ["alpha"]);
  assert.deepEqual(metrics.metricsMissingIds, ["beta"]);
  assert.deepEqual(metrics.micro.FAIL_TO_PASS, { success: 1, failure: 0, total: 1, rate: 1 });
  assert.deepEqual(metrics.micro.PASS_TO_PASS, { success: 1, failure: 1, total: 2, rate: 0.5 });
  assert.equal(metrics.perInstance.beta.metricsAvailable, false);
});

test("official harness never reuses an attempt directory after a partial crash", () => {
  assert.equal(nextHarnessAttemptNumber([{ attempt: 1 }], [1, 2]), 3);
  assert.equal(nextHarnessAttemptNumber([], [4]), 5);
});

test("official harness resume recovers verdict and test metrics from legacy and attempt reports", async () => {
  const root = await tempRoot("cpb-harness-report-recovery");
  const lane = "cpb_high_assurance" as const;
  const runId = "comparison-cpb_high_assurance";
  const legacyPath = path.join(root, "logs", "run_evaluation", runId, lane, "alpha", "report.json");
  const attemptPath = path.join(root, "attempts", "attempt-002", "beta", "report.json");
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await mkdir(path.dirname(attemptPath), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({
    alpha: {
      resolved: true,
      tests_status: { FAIL_TO_PASS: { success: ["f2p"], failure: [] } },
    },
  }));
  await writeFile(attemptPath, JSON.stringify({ beta: { resolved: false, tests_status: {} } }));
  const results = new Map<string, HarnessInstanceResult>([
    ["alpha", { instanceId: "alpha", resolved: true, reportPath: null, attempt: null, testsStatus: null }],
  ]);
  await recoverHarnessInstanceReports({
    harnessRoot: root,
    lane,
    runId,
    expectedIds: ["alpha", "beta"],
    instanceResults: results,
    attemptHistory: [{ attempt: 2, reportPaths: { beta: attemptPath } }],
  });
  assert.deepEqual(results.get("alpha")?.testsStatus, {
    FAIL_TO_PASS: { success: ["f2p"], failure: [] },
  });
  assert.equal(results.get("alpha")?.reportPath, legacyPath);
  assert.equal(results.get("beta")?.resolved, false);
  assert.equal(results.get("beta")?.attempt, 2);
});

test("official harness environment keeps Docker credential helpers discoverable", () => {
  const harnessEnv = buildHarnessEnvironment({ PATH: "/usr/bin:/bin" });
  const entries = String(harnessEnv.PATH).split(path.delimiter);
  assert.equal(entries.includes("/usr/local/bin"), true);
  if (process.platform === "darwin") {
    assert.equal(entries.includes("/Applications/Docker.app/Contents/Resources/bin"), true);
  }
});

test("execution contract freezes comparable models without provider credentials", () => {
  const contract = buildExecutionContract({
    runId: "comparison-run",
    count: 50,
    offset: 0,
    lanes: ["native_codex", "native_claude_glm", "cpb_high_assurance"],
    timeoutMs: 3_600_000,
    solverLaneConcurrency: {
      native_codex: 2,
      native_claude_glm: 2,
      cpb_high_assurance: 2,
    },
    solverAttempts: 3,
    solverRetryBackoffMs: 60_000,
    harnessTimeoutSeconds: 1_800,
    maxHarnessWorkers: 2,
    harnessAttempts: 3,
    harnessRetryBackoffMs: 60_000,
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "xhigh",
    glmModel: "glm-5.1[1m]",
  }, {
    codex: "codex-cli 0.144.1",
    claude: "2.1.168 (Claude Code)",
    codexAcp: {
      packageName: "@agentclientprotocol/codex-acp",
      packageVersion: "1.1.2",
      sha256: "b".repeat(64),
    },
  });

  assert.equal(contract.models.codex.effective, "gpt-5.6-sol");
  assert.equal(contract.schemaVersion, 16);
  assert.equal(contract.models.claudeGlm.effective, "glm-5.1");
  assert.equal(contract.models.claudeGlm.observedAssistantModelRequired, "glm-5.1");
  assert.equal(contract.models.claudeGlm.syntheticTransportErrorsExcludedFromIdentity, true);
  assert.deepEqual(contract.cpbRoute, {
    allowedAgents: ["codex", "claude-glm"],
    plannerA: "codex",
    plannerB: "claude-glm",
    executor: "claude-glm",
    verifier: "codex",
    verifierIndependentOfFinalMutator: true,
    invalidVerifierContractFeedbackRetry: true,
    baselineContractUsesDisposableWritableReplay: true,
  });
  assert.equal(contract.phaseBudgetPolicy.highAssurancePlanSemantics, "terminal_deny_only_without_budget_override");
  assert.equal(contract.phaseBudgetPolicy.byRisk.high.plan.toolCallBudget, 60);
  assert.equal(contract.phaseBudgetPolicy.byRisk.high.plan.toolEventBudget, 240);
  assert.equal(contract.phaseBudgetPolicy.byRisk.high.verify.toolCallBudget, 45);
  assert.deepEqual(contract.sourceBoundary.claudeRuntime, {
    bareMode: false,
    failIfSandboxUnavailable: true,
    pathGuardHook: true,
    strictEmptyMcpConfig: true,
    restrictedBuiltInTools: true,
    providerResetAwareRetry: true,
  });
  assert.equal(contract.binaries.codexAcp.packageVersion, "1.1.2");
  assert.deepEqual(contract.harness, {
    timeoutSeconds: 1_800,
    maxWorkers: 2,
    attempts: 3,
    retryBackoffMs: 60_000,
  });
  assert.deepEqual(contract.solver.laneConcurrency, {
    native_codex: 2,
    native_claude_glm: 2,
    cpb_high_assurance: 2,
  });
  assert.equal(contract.solver.retryableToolBudgetExceeded, true);
  assert.equal(contract.solver.providerResetAwareBackoff, true);
  assert.match(contract.contractSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(contract), /api[_-]?key|auth[_-]?token|secret/i);
});

test("CPB completion audit rejects same-family verification after an executor fallback", () => {
  const eventStream = (executeAgent: string, verifyAgent: string) => [
    JSON.stringify({ type: "phase_result", phase: "plan", agent: "codex", status: "passed" }),
    JSON.stringify({ type: "phase_result", phase: "execute", agent: executeAgent, status: "passed" }),
    JSON.stringify({ type: "phase_result", phase: "verify", agent: verifyAgent, status: "passed" }),
  ].join("\n");

  assert.equal(independentVerificationContractViolation(eventStream("claude-glm", "codex")), null);
  assert.equal(independentVerificationContractViolation(eventStream("codex", "claude-glm")), null);
  assert.equal(
    independentVerificationContractViolation(eventStream("codex", "codex")),
    "independent_verification_provider_reuse:codex:codex",
  );
});

test("CPB launch audit fails closed when any agent is outside the frozen universe", () => {
  const validAudit = [
    JSON.stringify({ event: "agent_launch", agent: "codex", command: "codex-acp" }),
    JSON.stringify({ event: "agent_launch", agent: "claude-glm", command: "claude", model: "glm-5.2" }),
  ].join("\n");
  assert.equal(agentLaunchContractViolation(validAudit, ["codex", "claude-glm"]), null);

  const contaminated = `${validAudit}\n${JSON.stringify({
    event: "agent_launch",
    agent: "claude",
    command: "claude-agent-acp",
  })}`;
  assert.equal(
    agentLaunchContractViolation(contaminated, ["codex", "claude-glm"]),
    "agent_launch_outside_contract:claude",
  );
  assert.equal(
    agentLaunchContractViolation("", ["codex", "claude-glm"]),
    "agent_launch_audit_missing",
  );
});

test("Claude/GLM streams attest the actual assistant model and reject drift", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", model: "glm-5.2" }),
    "not-json",
    JSON.stringify({ type: "assistant", message: { model: "glm-5.2" } }),
    JSON.stringify({ type: "result", modelUsage: { "glm-5.2": { outputTokens: 4 } } }),
  ].join("\n");
  const attestation = observedModelAttestation(stream);
  assert.deepEqual(attestation, {
    initModels: ["glm-5.2"],
    assistantModels: ["glm-5.2"],
    modelUsageModels: ["glm-5.2"],
  });
  assert.equal(observedModelContractViolation(attestation, "glm-5.2"), null);
  assert.equal(
    observedModelContractViolation(attestation, "glm-5.1"),
    "observed_assistant_model_mismatch:glm-5.2:expected:glm-5.1",
  );
  assert.equal(
    observedModelContractViolation({ ...attestation, assistantModels: [] }, "glm-5.2"),
    "observed_assistant_model_missing",
  );
  assert.equal(observedModelContractViolation({
    ...attestation,
    assistantModels: ["<synthetic>"],
    modelUsageModels: [],
  }, "glm-5.2"), null);
  assert.equal(observedModelContractViolation({
    ...attestation,
    assistantModels: ["<synthetic>", "glm-5.2"],
  }, "glm-5.2"), null);
  assert.equal(
    observedModelContractViolation({
      ...attestation,
      assistantModels: ["<synthetic>", "glm-5.1"],
    }, "glm-5.2"),
    "observed_assistant_model_mismatch:glm-5.1:expected:glm-5.2",
  );
});

test("native Claude comparison lane has a fail-closed native sandbox and path hook", async () => {
  const root = await tempRoot("cpb-native-claude-sandbox");
  const sourcePath = path.join(root, "source");
  const laneRoot = path.join(root, "lane");
  await mkdir(sourcePath, { recursive: true });
  const env = buildNativeClaudeIsolatedEnv(laneRoot, { PATH: process.env.PATH });
  const guardScript = path.join(root, "runtime-dist", "scripts", "claude-path-guard.js");
  const dependencyRoot = path.join(root, "runtime", "site-packages");
  const installedProject = path.join(dependencyRoot, "project_pkg");
  const boundary = {
    schemaVersion: 1 as const,
    homeDenyRoot: root,
    projectPackageNames: ["project_pkg"],
    dependencyReadRoots: [dependencyRoot],
    denyReadPaths: [installedProject],
  };
  const settings = buildNativeClaudeSettings(
    sourcePath,
    String(env.HOME),
    String(env.TMPDIR),
    guardScript,
    boundary,
  );
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: {
      allowWrite: [sourcePath, path.join(laneRoot, "agent-homes", "claude-glm"), path.join(laneRoot, "tmp", "claude-glm")],
      denyRead: [root, installedProject],
      allowRead: [
        path.join(laneRoot, "agent-homes", "claude-glm"),
        sourcePath,
        path.join(laneRoot, "tmp", "claude-glm"),
      ].sort(),
    },
    network: { allowedDomains: [] },
  });
  assert.deepEqual(settings.permissions.deny, [
    "WebSearch",
    "WebFetch",
    `Read(//${installedProject.replace(/^\/+/, "")}/**)`,
  ]);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Read|Edit|Write|MultiEdit|Bash");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /claude-path-guard\.js/);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /source/);
  assert.equal(env.HOME, path.join(laneRoot, "agent-homes", "claude-glm"));
  const args = buildNativeClaudeArgs("glm-5.2", path.join(laneRoot, "settings.json"), "fix the bug");
  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--include-hook-events"), true);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.includes("--disable-slash-commands"), true);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash");
});

test("comparison scoring reads the immutable CPB replay bundle instead of a verifier-mutated worktree", async () => {
  const root = await tempRoot("cpb-comparison-candidate-replay");
  const outputs = path.join(root, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });
  const patch = "diff --git a/a.txt b/a.txt\n";
  const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const unsigned = {
    schemaVersion: 1 as const,
    baseSha: "a".repeat(40),
    expectedTreeHash: "b".repeat(40),
    candidateIdentityHash: `sha256:${"c".repeat(64)}`,
    patchSha256: digest(patch),
    patchBytes: Buffer.byteLength(patch),
    patch,
  };
  const bundleHash = digest(JSON.stringify({
    schemaVersion: unsigned.schemaVersion,
    baseSha: unsigned.baseSha,
    expectedTreeHash: unsigned.expectedTreeHash,
    candidateIdentityHash: unsigned.candidateIdentityHash,
    patchSha256: unsigned.patchSha256,
    patchBytes: unsigned.patchBytes,
  }));
  const bundlePath = path.join(outputs, "candidate-replay-bundle-1.md");
  await writeFile(bundlePath, JSON.stringify({ ...unsigned, bundleHash }), "utf8");

  const replay = await latestCandidateReplayBundle(outputs);
  assert.equal(replay.error, null);
  assert.equal(replay.path, bundlePath);
  assert.equal(replay.bundle?.patch, patch);
});
