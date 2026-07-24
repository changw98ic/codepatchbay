#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const RUNTIME_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..");
const COMPILED_TEST_ROOT = path.join(REPO_ROOT, "dist-tests");
const COMPILED_TEST_RUNNER = path.join(COMPILED_TEST_ROOT, "scripts", "run-node-tests.js");
const args = new Set(process.argv.slice(2));

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";
const SKIP = "\x1b[0;33mSKIP\x1b[0m";

const focusedTests = [
  "tests/adversarial-verdict-events.test.js",
  "tests/setup-manifest-registry.test.js",
  "tests/setup-snapshot-contract.test.js",
  "tests/setup-version-pin.test.js",
  "tests/github-signature.test.js",
  "tests/github-issue-queue.test.js",
  "tests/github-draft-pr.test.js",
  "tests/artifact-index-contract.test.js",
  "tests/assignment-finalizer.test.js",
  "tests/auto-finalizer.test.js",
  "tests/job-artifact-detail.test.js",
  "tests/audit-export.test.js",
  "tests/runtime-health-gate.test.js",
  "tests/runtime-artifact-events.test.js",
  "tests/runtime-failure-recorder.test.js",
  "tests/completion-checklist-artifacts.test.js",
  "tests/completion-failure.test.js",
  "tests/completion-gate-runner.test.js",
  "tests/completion-success.test.js",
  "tests/workflow-definition-contract.test.js",
  "tests/dag-builder.test.js",
  "tests/dag-executor.test.js",
  "tests/dag-resume-contract.test.js",
  "tests/dag-node-resume.test.js",
  "tests/dag-node-lifecycle-events.test.js",
  "tests/dag-node-failure.test.js",
  "tests/engine-prepare-task.test.js",
  "tests/job-recovery-hardening.test.js",
  "tests/job-recovery.test.js",
  "tests/engine-provider-event.test.js",
  "tests/poisoned-session.test.js",
  "tests/poisoned-session-gate.test.js",
  "tests/patch-integrity.test.js",
  "tests/phase-agent-routing.test.js",
  "tests/phase-artifact-tracker.test.js",
  "tests/phase-budget-policy.test.js",
  "tests/product-gate.test.js",
  "tests/run-job-planning.test.js",
  "tests/run-phase.test.js",
  "tests/phase-retry.test.js",
  "tests/phase-result-events.test.js",
  "tests/phase-start-events.test.js",
  "tests/provider-handoff.test.js",
  "tests/provider-quota-fallback.test.js",
  "tests/provider-usage-recorder.test.js",
  "tests/scope-guard.test.js",
  "tests/scope-guard-runner.test.js",
  "tests/stabilization-gate.test.js",
  "tests/strict-engine-gate.test.js",
  "tests/swebench-batch-queue.test.js",
  "tests/type-debt-guard.test.js",
  "tests/verify-p0p1-runner.test.js",
  "tests/queue-orchestrator.test.js",
  "tests/release-gate-runner.test.js",
  "tests/release-readiness-report.test.js",
  "tests/acp-supervisor.test.js",
  "tests/codegraph-capability-map.test.js",
  "tests/checklist-decompose-integration.test.js",
  "tests/integration/fake-acp-smoke.test.js",
];

const isolatedFocusedTests = [
  "tests/integration/managed-worker.test.js",
];

function commandText(command: string, commandArgs: string[]) {
  return [command, ...commandArgs].join(" ");
}

function run(label: string, command: string, commandArgs: string[], options: { env?: Record<string, string> } = {}) {
  console.log(`\n${label}`);
  console.log(`$ ${commandText(command, commandArgs)}`);
  return new Promise((resolve) => {
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

async function assertFocusedTestsExist(paths: string[]) {
  const missing = [];
  for (const testPath of paths) {
    try {
      await access(path.join(COMPILED_TEST_ROOT, testPath));
    } catch {
      missing.push(testPath);
    }
  }
  if (missing.length > 0) {
    console.error(`${FAIL} missing focused P0/P1 test files:\n${missing.map((file) => `- ${file}`).join("\n")}`);
    return false;
  }
  return true;
}

async function runLiveChecks() {
  if (!args.has("--live") && process.env.CPB_VERIFY_LIVE !== "1") {
    console.log(`\n${SKIP} live checks: pass --live or set CPB_VERIFY_LIVE=1`);
    return true;
  }

  const checks = [];
  checks.push(await run("live: gh auth status", "gh", ["auth", "status"]));

  if (process.env.CPB_SLACK_BOT_TOKEN) {
    checks.push(await run("live: Slack auth.test", process.execPath, [
      "-e",
      "const r=await fetch('https://slack.com/api/auth.test',{headers:{Authorization:`Bearer ${process.env.CPB_SLACK_BOT_TOKEN}`}}); const j=await r.json(); if(!j.ok){console.error(j); process.exit(1)} console.log(JSON.stringify({ok:j.ok, team:j.team, user:j.user}, null, 2));",
    ]));
  } else {
    console.log(`${SKIP} live: Slack auth.test requires CPB_SLACK_BOT_TOKEN`);
  }

  return checks.every(Boolean);
}

const checks = [];

if (!(await assertFocusedTestsExist([...focusedTests, ...isolatedFocusedTests]))) {
  console.error(`\n${FAIL} P0/P1 verification failed.`);
  process.exitCode = 1;
} else {
  checks.push(await run("static: git diff --check", "git", ["diff", "--check"]));
  checks.push(await run("focused P0/P1 node tests", process.execPath, [COMPILED_TEST_RUNNER, ...focusedTests]));
  checks.push(await run("focused P0/P1 isolated node tests", process.execPath, [
    COMPILED_TEST_RUNNER,
    ...isolatedFocusedTests,
  ]));
  checks.push(await run("CLI smoke", process.execPath, [path.join(RUNTIME_ROOT, "scripts", "ci-smoke.js")]));
  checks.push(await runLiveChecks());

  if (args.has("--full")) {
    checks.push(await run("full test suite", "npm", ["test"]));
  } else {
    console.log(`\n${SKIP} full test suite: pass --full to run npm test`);
  }

  if (!checks.every(Boolean)) {
    console.error(`\n${FAIL} P0/P1 verification failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${PASS} P0/P1 verification passed.`);
  }
}
