#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";
const SKIP = "\x1b[0;33mSKIP\x1b[0m";

const focusedTests = [
  "tests/setup-gateway.test.mjs",
  "tests/github-gateway.test.mjs",
  "tests/channel-commands.test.mjs",
  "tests/permission-react.test.mjs",
  "tests/slack-comments.test.mjs",
  "tests/cli-entrypoints.test.mjs",
  "tests/review-bundle.test.mjs",
  "tests/managed-worker-finalizer.test.mjs",
  "tests/inbox-routes.test.mjs",
  "tests/verify-hard-gates.test.mjs",
  "tests/failure-router.test.mjs",
  "tests/prompt-builder-contract.test.mjs",
];

function commandText(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function run(label, command, commandArgs, options = {}) {
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
checks.push(await run("CLI smoke", process.execPath, ["scripts/ci-smoke.mjs"]));
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
