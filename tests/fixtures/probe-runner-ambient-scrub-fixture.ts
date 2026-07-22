import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runChecklistProbes } from "../../core/workflow/probe-runner.js";
import { LooseRecord } from "../../shared/types.js";

const exec = (cmd: string, args: string[], opts: LooseRecord = {}) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
  });

async function makeGitRepo() {
  const dir = path.join(os.tmpdir(), `probe-scrub-fixture-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# init\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function trustProbes(dir: string, probes: Array<{ predicateId: string; executable: string; args: string[] }>) {
  await mkdir(path.join(dir, ".cpb"), { recursive: true });
  await writeFile(
    path.join(dir, ".cpb", "verification-probes.json"),
    JSON.stringify({ schemaVersion: 1, probes }, null, 2) + "\n",
    "utf8",
  );
  await exec("git", ["add", ".cpb/verification-probes.json"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "add trusted probe policy"], { cwd: dir });
}

function checklist(items: LooseRecord[]) {
  return { schemaVersion: 1, jobId: "job-ns", project: "p", status: "frozen", items, assumptions: [] };
}

function commandItem(overrides: LooseRecord = {}) {
  return {
    id: "AC-CMD",
    requirement: "command succeeds",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-CMD",
    required: true,
    area: "build",
    risk: "low",
    verificationMethod: "command",
    ...overrides,
  };
}

const dir = await makeGitRepo();
try {
  await writeFile(
    path.join(dir, "probe-env.mjs"),
    [
      "const secretPresent = Boolean(process.env.CPB_HUB_TOKEN);",
      "if (secretPresent) process.exit(9);",
      "console.log('environment scrubbed');",
    ].join("\n") + "\n",
    "utf8",
  );
  await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: process.execPath, args: ["probe-env.mjs"] }]);
  assert.equal(process.env.CPB_HUB_TOKEN, "ambient-secret-must-not-reach-child");
  const item = commandItem({ expectedEvidence: "trusted environment isolation probe passes" });
  const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123" } });
  const obs = checks[0].observation;
  assert.equal(obs.exitCode, 0);
  assert.equal(obs.stdoutTail, "environment scrubbed\n");
  console.log(JSON.stringify({
    exitCode: obs.exitCode,
    secretPresent: false,
    stdoutTail: obs.stdoutTail,
  }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
