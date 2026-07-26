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

function setupGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

async function makeGitRepo() {
  const dir = path.join(os.tmpdir(), `probe-oracle-env-fixture-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  const env = setupGitEnv();
  await exec("git", ["init", "-q"], { cwd: dir, env });
  await exec("git", ["config", "user.email", "t@t"], { cwd: dir, env });
  await exec("git", ["config", "user.name", "t"], { cwd: dir, env });
  await writeFile(path.join(dir, "README.md"), "# init\n", "utf8");
  await exec("git", ["add", "-A"], { cwd: dir, env });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

async function trustProbes(dir: string, probes: Array<{ predicateId: string; executable: string; args: string[] }>) {
  await mkdir(path.join(dir, ".cpb"), { recursive: true });
  await writeFile(
    path.join(dir, ".cpb", "verification-probes.json"),
    JSON.stringify({ schemaVersion: 1, probes }, null, 2) + "\n",
    "utf8",
  );
  const env = setupGitEnv();
  await exec("git", ["add", ".cpb/verification-probes.json"], { cwd: dir, env });
  await exec("git", ["commit", "-q", "-m", "add trusted probe policy"], { cwd: dir, env });
}

async function addOracleFixture(dir: string) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await writeFile(path.join(dir, "src", "value.txt"), "old\n", "utf8");
  await writeFile(
    path.join(dir, "tests", "acceptance.sh"),
    [
      "value=$(cat src/value.txt)",
      "if [ \"$value\" != \"fixed\" ]; then",
      "  echo \"expected fixed, got $value\" >&2",
      "  exit 1",
      "fi",
      "echo oracle passed",
    ].join("\n") + "\n",
    "utf8",
  );
  const env = setupGitEnv();
  await exec("git", ["add", "-A"], { cwd: dir, env });
  await exec("git", ["commit", "-q", "-m", "oracle fixture"], { cwd: dir, env });
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
  assert.equal(process.env.GIT_DIR, "/tmp/cpb-ambient-bad-git-dir");
  await addOracleFixture(dir);
  await writeFile(path.join(dir, "tests", "acceptance.sh"), "echo polluted local pass\n", "utf8");
  await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["tests/acceptance.sh"] }]);

  const item = commandItem({
    expectedEvidence: "trusted acceptance oracle passes",
    requiredEvidenceOrigin: "user_required",
    sourceRefs: [{ kind: "document", locator: "tests/acceptance.sh:1" }],
  });
  const checks = await runChecklistProbes(checklist([item]), dir, {
    finalWorktree: { head: "abc123", diffHash: "sha256:d" },
    env: {},
  });

  const obs = checks[0].observation;
  assert.equal(process.env.CPB_CLEAN_ORACLE_REPLAY_ACTIVE_FALLBACK, "1");
  assert.equal(obs.exitCode, 0);
  assert.equal(obs.cleanOracleReplayPassed, false);
  assert.equal(obs.cleanOracleReplayMode, "isolated_worktree");
  assert.equal(obs.cleanOracleReplayFallbackFrom, undefined);
  console.log(JSON.stringify({
    exitCode: obs.exitCode,
    ambientGitDirWasSet: true,
    cleanOracleReplayPassed: obs.cleanOracleReplayPassed,
    cleanOracleReplayMode: obs.cleanOracleReplayMode,
    cleanOracleReplayFallbackFrom: obs.cleanOracleReplayFallbackFrom,
  }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
