#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";

const gateTests = [
  "dist-tests/tests/adversarial-verdict-events.test.js",
  "dist-tests/tests/checklist-decompose-integration.test.js",
  "dist-tests/tests/checklist-artifact-index.test.js",
  "dist-tests/tests/checklist-completion-gate.test.js",
  "dist-tests/tests/completion-checklist-artifacts.test.js",
  "dist-tests/tests/completion-failure.test.js",
  "dist-tests/tests/completion-gate-runner.test.js",
  "dist-tests/tests/completion-success.test.js",
  "dist-tests/tests/assignment-finalizer.test.js",
  "dist-tests/tests/auto-finalizer.test.js",
  "dist-tests/tests/github-draft-pr.test.js",
  "dist-tests/tests/disposable-draft-pr-rehearsal.test.js",
  "dist-tests/tests/live-release-evidence.test.js",
  "dist-tests/tests/product-gate.test.js",
  "dist-tests/tests/release-readiness-report.test.js",
  "dist-tests/tests/dag-node-resume.test.js",
  "dist-tests/tests/dag-node-lifecycle-events.test.js",
  "dist-tests/tests/dag-node-failure.test.js",
  "dist-tests/tests/phase-agent-routing.test.js",
  "dist-tests/tests/phase-artifact-tracker.test.js",
  "dist-tests/tests/phase-budget-policy.test.js",
  "dist-tests/tests/phase-result-events.test.js",
  "dist-tests/tests/phase-start-events.test.js",
  "dist-tests/tests/provider-usage-recorder.test.js",
  "dist-tests/tests/runtime-artifact-events.test.js",
  "dist-tests/tests/runtime-failure-recorder.test.js",
  "dist-tests/tests/scope-guard-runner.test.js",
  "dist-tests/tests/swebench-batch-queue.test.js",
];

const flagshipWorkerE2ePattern = "managed worker flagship issue to draft PR dry-run uses default checklist decomposition and evidence";

function commandText(command: string, commandArgs: string[]) {
  return [command, ...commandArgs].join(" ");
}

function run(label: string, command: string, commandArgs: string[], options: { env?: Record<string, string | undefined> } = {}) {
  console.log(`\n${label}`);
  console.log(`$ ${commandText(command, commandArgs)}`);
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        CPB_WORKER_DISPATCH_ENABLED: "0",
        ...(options.env || {}),
      },
    });
    child.on("close", (code) => {
      const ok = code === 0;
      console.log(`${ok ? PASS : FAIL} ${label}`);
      resolve(ok);
    });
    child.on("error", (error) => {
      console.error(`${FAIL} ${label}: ${error.message}`);
      resolve(false);
    });
  });
}

if (process.env.CPB_CHECKLIST_DECOMPOSE === "0") {
  console.error(`${FAIL} CPB_CHECKLIST_DECOMPOSE=0 is not allowed for the release gate.`);
  process.exitCode = 1;
} else if (process.env.CPB_AGENT_ISOLATE_HOME === "0") {
  console.error(`${FAIL} CPB_AGENT_ISOLATE_HOME=0 is not allowed for the release gate.`);
  process.exitCode = 1;
} else {
  const checks = [
    await run("release gate: release readiness report", process.execPath, [
      "dist/scripts/release-readiness-report.js",
    ]),
    await run("release gate: production checklist and finalizer contract tests", process.execPath, [
      "--test",
      ...gateTests,
    ]),
    await run("release gate: managed worker flagship issue-to-draft-PR E2E", process.execPath, [
      "--test",
      "--test-name-pattern",
      flagshipWorkerE2ePattern,
      "dist-tests/tests/integration/managed-worker.test.js",
    ]),
  ];

  if (!checks.every(Boolean)) {
    console.error(`\n${FAIL} Release gate failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${PASS} Release gate passed.`);
  }
}
