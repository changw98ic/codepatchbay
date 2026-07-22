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
  const dir = path.join(os.tmpdir(), `probe-env-fixture-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
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
  await writeFile(
    path.join(dir, "probe-job-env.mjs"),
    [
      "const ambientValues = ['/cpb-ambient-home', '/cpb-ambient-bin', 'cpb-ambient-user', 'ambient-hub-secret-must-not-reach-child', 'ambient-openai-secret-must-not-reach-child'];",
      "const snapshot = {",
      "  home: process.env.HOME,",
      "  path: process.env.PATH,",
      "  user: process.env.USER,",
      "  ci: process.env.CI,",
      "  pythonpath: process.env.PYTHONPATH,",
      "  secretPresent: Boolean(process.env.CPB_HUB_TOKEN || process.env.OPENAI_API_KEY),",
      "  ambientLeakPresent: ambientValues.some((value) => Object.values(process.env).some((envValue) => String(envValue || '').includes(value))),",
      "};",
      "console.log(JSON.stringify(snapshot));",
    ].join("\n") + "\n",
    "utf8",
  );
  await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: process.execPath, args: ["probe-job-env.mjs"] }]);
  const item = commandItem({ expectedEvidence: "trusted job env probe passes" });
  const checks = await runChecklistProbes(checklist([item]), dir, {
    finalWorktree: { head: "abc123" },
    env: {
      HOME: "/cpb-job-home",
      PATH: `/cpb-job-bin:${process.env.CPB_ORIGINAL_PATH || ""}`,
      USER: "cpb-job-user",
      CPB_HUB_TOKEN: "explicit-hub-secret-must-not-reach-child",
      OPENAI_API_KEY: "explicit-openai-secret-must-not-reach-child",
    },
  });
  const obs = checks[0].observation;
  assert.equal(obs.exitCode, 0);
  const stdout = String(obs.stdoutTail);
  const result = JSON.parse(stdout) as LooseRecord;
  assert.deepEqual(result, {
    home: "/cpb-job-home",
    path: `/cpb-job-bin:${process.env.CPB_ORIGINAL_PATH || ""}`,
    user: "cpb-job-user",
    ci: "1",
    pythonpath: dir,
    secretPresent: false,
    ambientLeakPresent: false,
  });
  console.log(JSON.stringify({ exitCode: obs.exitCode, ambientGitDirWasSet: true, ...result }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
