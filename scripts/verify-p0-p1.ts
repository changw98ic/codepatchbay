#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";
const SKIP = "\x1b[0;33mSKIP\x1b[0m";

const focusedTests = [
  "tests/setup-manifest-registry.test.js",
  "tests/setup-snapshot-contract.test.js",
  "tests/setup-version-pin.test.js",
  "tests/github-signature.test.js",
  "tests/github-trigger-rules.test.js",
  "tests/github-issue-queue.test.js",
  "tests/integration/api-github-policy.test.js",
  "tests/channel-policy.test.js",
  "tests/channel-slack-commands.test.js",
  "tests/artifact-index-contract.test.js",
  "tests/job-artifact-detail.test.js",
  "tests/audit-export.test.js",
  "tests/runtime-health-gate.test.js",
  "tests/workflow-definition-contract.test.js",
  "tests/dag-resume-contract.test.js",
  "tests/attention-projection.test.js",
  "tests/engine-prepare-task.test.js",
  "tests/job-recovery.test.js",
  "tests/engine-provider-event.test.js",
  "tests/queue-orchestrator.test.js",
  "tests/acp-supervisor.test.js",
  "tests/codegraph-capability-map.test.js",
  "tests/integration/release-pack-smoke.test.js",
];

const isolatedFocusedTests = [
  "tests/integration/managed-worker.test.js",
];

function commandText(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function run(label, command, commandArgs, options: { env?: Record<string, string> } = {}) {
  console.log(`\n${label}`);
  console.log(`$ ${commandText(command, commandArgs)}`);
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
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

checks.push(await run("static: git diff --check", "git", ["diff", "--check"]));
checks.push(await run("focused P0/P1 node tests", process.execPath, ["--test", ...focusedTests]));
checks.push(await run("focused P0/P1 isolated node tests", process.execPath, [
  "--test-concurrency=1",
  "--test",
  ...isolatedFocusedTests,
]));
checks.push(await run("CLI smoke", process.execPath, ["scripts/ci-smoke.js"]));
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
