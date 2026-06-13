import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cli = path.join(repoRoot, "cli", "cpb.js");

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CPB_ROOT: repoRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("unknown command returns error and nonzero exit code", async () => {
  const result = await runCli(["nonexistent-command-xyz"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: nonexistent-command-xyz/);
});

test("known commands resolve and help lists them", async () => {
  // `help` must exit 0 and document the core commands (not the removed
  // artifacts/verdict commands). Strip ANSI color codes first — the usage
  // text colorizes command names (e.g. \x1B[0;36mrun\x1B[0m), which would
  // break word-boundary matching.
  const help = await runCli(["help"]);
  assert.equal(help.code, 0);
  const plain = help.stdout.replace(/\x1B\[[0-9;]*m/g, "");
  assert.match(plain, /\bpipeline\b/);
  assert.match(plain, /\brun\b/);
  assert.match(plain, /\binbox\b/);
  assert.doesNotMatch(plain, /\bartifacts\b/);
  assert.doesNotMatch(plain, /\bverdict\b/);
});

test("removed commands are reported as unknown", async () => {
  const artifacts = await runCli(["artifacts"]);
  assert.equal(artifacts.code, 1);
  assert.match(artifacts.stderr, /Unknown command: artifacts/);

  const verdict = await runCli(["verdict"]);
  assert.equal(verdict.code, 1);
  assert.match(verdict.stderr, /Unknown command: verdict/);
});

test("alias relationships resolve to the same exit behavior", async () => {
  // `run`/`pipeline` and `cancel`/`redirect` resolve to the same module, so
  // invoking either alias with no required args produces the same usage error
  // (proving they share a command module) rather than "Unknown command".
  const run = await runCli(["run"]);
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.stderr, /Unknown command: run/);

  const pipeline = await runCli(["pipeline"]);
  assert.equal(pipeline.code, 1);
  assert.doesNotMatch(pipeline.stderr, /Unknown command: pipeline/);

  const cancel = await runCli(["cancel"]);
  assert.equal(cancel.code, 1);
  assert.doesNotMatch(cancel.stderr, /Unknown command: cancel/);

  const redirect = await runCli(["redirect"]);
  assert.equal(redirect.code, 1);
  assert.doesNotMatch(redirect.stderr, /Unknown command: redirect/);
});
