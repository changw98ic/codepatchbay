import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { LooseRecord } from "../shared/types.js";

import { runChecklistProbes } from "../core/workflow/probe-runner.js";
import { validateEvidenceObservation } from "../core/workflow/evidence-probes.js";


const exec = (cmd: string, args: string[], opts: LooseRecord = {}) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, opts, (err) => (err ? reject(err) : resolve()));
  });

const execJson = (cmd: string, args: string[], opts: LooseRecord = {}) =>
  new Promise<LooseRecord>((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout || "{}")) as LooseRecord);
      } catch (parseErr) {
        reject(Object.assign(parseErr as Error, { stdout, stderr }));
      }
    });
  });

async function makeGitRepo() {
  const dir = path.join(await import("node:os").then((m) => m.tmpdir()), `probe-ns-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
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
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "oracle fixture"], { cwd: dir });
}

function runtimeEventItem(overrides: LooseRecord = {}) {
  return {
    id: "AC-EVT",
    requirement: "an event fired",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-EVT",
    required: true,
    area: "runtime",
    risk: "low",
    verificationMethod: "runtime_event",
    ...overrides,
  };
}

function staticItem(overrides: LooseRecord = {}) {
  return {
    id: "AC-STATIC",
    requirement: "update README",
    source: "task_text",
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    predicateId: "PRED-STATIC",
    required: true,
    area: "docs",
    risk: "low",
    verificationMethod: "static",
    expectedEvidence: "README diff",
    allowedFiles: ["README.md"],
    ...overrides,
  };
}

test("command item with a declared succeeding command -> valid claim, exitCode 0, stdoutSha256 present, passes validateEvidenceObservation", async () => {
  const dir = await makeGitRepo();
  try {
    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "printf", args: ["hello"] }]);
    const item = commandItem({ expectedEvidence: "trusted printf probe exits zero" });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "command");
    assert.equal(obs.command, '"printf" "hello"');
    assert.equal(obs.exitCode, 0);
    assert.match(obs.stdoutSha256, /^sha256:[0-9a-f]+$/);
    assert.equal(checks[0].emitFailedClaim, true);

    // The observation must be structurally valid (recordable) AND satisfied (exit 0 + worktreeHead).
    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true, "command observation should be valid");
    assert.equal(v.satisfied, true, "command observation should satisfy (exit 0 + worktreeHead)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-benchmark command targets cover CLI, API integration, migration dry-run, and UI flow checks", async () => {
  const dir = await makeGitRepo();
  try {
    await mkdir(path.join(dir, "probes"), { recursive: true });
    const scripts = [
      ["cli-smoke.sh", "echo cli smoke ok"],
      ["api-integration.sh", "echo api integration ok"],
      ["migration-dry-run.sh", "echo migration dry-run ok"],
      ["ui-flow.sh", "echo ui flow ok"],
    ];
    for (const [name, body] of scripts) {
      await writeFile(path.join(dir, "probes", name), `${body}\n`, "utf8");
    }
    const expectedCommands = [
      '"sh" "probes/cli-smoke.sh"',
      '"sh" "probes/api-integration.sh"',
      '"sh" "probes/migration-dry-run.sh"',
      '"sh" "probes/ui-flow.sh"',
    ];
    const items = [
      commandItem({ id: "AC-CLI", predicateId: "PRED-CLI", area: "cli", expectedEvidence: "CLI smoke passes" }),
      commandItem({ id: "AC-API", predicateId: "PRED-API", area: "api", expectedEvidence: "API integration passes" }),
      commandItem({ id: "AC-MIG", predicateId: "PRED-MIG", area: "database", expectedEvidence: "migration dry run passes" }),
      commandItem({ id: "AC-UI", predicateId: "PRED-UI", area: "ui", expectedEvidence: "UI flow passes" }),
    ];
    await trustProbes(dir, items.map((item, index) => ({
      predicateId: String(item.predicateId),
      executable: "sh",
      args: [String(scripts[index][0] && `probes/${scripts[index][0]}`)],
    })));

    const checks = await runChecklistProbes(checklist(items), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 4);
    for (const [index, check] of checks.entries()) {
      const obs = check.observation;
      assert.equal(obs.command, expectedCommands[index]);
      assert.equal(obs.exitCode, 0);
      const validation = validateEvidenceObservation(obs, items[index], { attemptId: "" });
      assert.equal(validation.valid, true, String(items[index].id));
      assert.equal(validation.satisfied, true, String(items[index].id));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command probes run with the repository root on PYTHONPATH", async () => {
  const dir = await makeGitRepo();
  try {
    await mkdir(path.join(dir, "tests"), { recursive: true });
    await mkdir(path.join(dir, "samplepkg"), { recursive: true });
    await writeFile(path.join(dir, "samplepkg", "__init__.py"), "VALUE = 'local-package'\n", "utf8");
    await writeFile(
      path.join(dir, "tests", "runtests.py"),
      "import samplepkg\nprint(samplepkg.VALUE)\n",
      "utf8",
    );

    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "python3", args: ["./tests/runtests.py"] }]);
    const item = commandItem({ expectedEvidence: "local Python test prints package value" });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 0);

    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true);
    assert.equal(v.satisfied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command item whose command exits non-zero -> honest fail claim, result fail, exitCode captured", async () => {
  const dir = await makeGitRepo();
  try {
    await writeFile(path.join(dir, "fail.sh"), "exit 7\n", "utf8");
    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["./fail.sh"] }]);
    const item = commandItem({ expectedEvidence: "trusted failure fixture exits 7" });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 7, "real non-zero exit code must be captured honestly");
    assert.equal(checks[0].emitFailedClaim, true);

    // valid (recordable) but NOT satisfied (exitCode !== 0).
    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true, "failed command observation should still be valid (recordable)");
    assert.equal(v.satisfied, false, "non-zero exit must not satisfy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command probe retries a transient non-zero exit and records attempt diagnostics", async () => {
  const dir = await makeGitRepo();
  try {
    await writeFile(
      path.join(dir, "flaky.sh"),
      [
        "count_file=.flaky-count",
        "count=$(cat \"$count_file\" 2>/dev/null || printf 0)",
        "next=$((count + 1))",
        "printf '%s' \"$next\" > \"$count_file\"",
        "if [ \"$next\" = 1 ]; then",
        "  echo first failure >&2",
        "  exit 7",
        "fi",
        "echo retry passed",
      ].join("\n") + "\n",
      "utf8",
    );

    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["./flaky.sh"] }]);
    const item = commandItem({ expectedEvidence: "trusted flaky fixture passes on retry" });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 0, "transient command failure should be retried once");
    assert.equal(obs.retryCount, 1);
    assert.match(String(obs.note), /passed after 1 retry/);
    assert.equal(Array.isArray(obs.probeAttempts), true);
    const attempts = obs.probeAttempts as LooseRecord[];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].exitCode, 7);
    assert.match(String(attempts[0].stderrTail), /first failure/);
    assert.equal(attempts[1].exitCode, 0);
    assert.match(String(obs.stdoutTail), /retry passed/);

    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true);
    assert.equal(v.satisfied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command probe marks clean oracle replay when restored acceptance file still passes", async () => {
  const dir = await makeGitRepo();
  try {
    await addOracleFixture(dir);
    await writeFile(path.join(dir, "src", "value.txt"), "fixed\n", "utf8");
    await writeFile(path.join(dir, "tests", "acceptance.sh"), "echo polluted local pass\n", "utf8");

    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["tests/acceptance.sh"] }]);
    const item = commandItem({
      expectedEvidence: "trusted acceptance oracle passes",
      requiredEvidenceOrigin: "user_required",
      sourceRefs: [{ kind: "document", locator: "tests/acceptance.sh:1" }],
    });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });

    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 0);
    assert.equal(obs.cleanOracleReplayPassed, true);
    assert.equal(obs.cleanOracleReplayExitCode, 0);
    assert.deepEqual(obs.cleanOracleReplayFiles, ["tests/acceptance.sh"]);
    assert.match(String(obs.cleanOracleReplayStdoutTail), /oracle passed/);
    assert.equal(await readFile(path.join(dir, "tests", "acceptance.sh"), "utf8"), "echo polluted local pass\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command probe records failed clean oracle replay and restores polluted file", async () => {
    const dir = await makeGitRepo();
  try {
    await addOracleFixture(dir);
    await writeFile(path.join(dir, "tests", "acceptance.sh"), "echo polluted local pass\n", "utf8");

    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["tests/acceptance.sh"] }]);
    const item = commandItem({
      expectedEvidence: "trusted acceptance oracle passes",
      requiredEvidenceOrigin: "user_required",
      sourceRefs: [{ kind: "document", locator: "tests/acceptance.sh:1" }],
    });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });

    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 0);
    assert.equal(obs.cleanOracleReplayPassed, false);
    assert.equal(obs.cleanOracleReplayExitCode, 1);
    assert.deepEqual(obs.cleanOracleReplayFiles, ["tests/acceptance.sh"]);
    assert.match(String(obs.cleanOracleReplayStderrTail), /expected fixed, got old/);
    assert.equal(await readFile(path.join(dir, "tests", "acceptance.sh"), "utf8"), "echo polluted local pass\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command probe runs clean oracle replay in an isolated overlay worktree", async () => {
  const dir = await makeGitRepo();
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "tests"), { recursive: true });
    await writeFile(path.join(dir, "src", "value.txt"), "old\n", "utf8");
    await writeFile(
      path.join(dir, "tests", "acceptance.sh"),
      [
        "value=$(cat src/value.txt)",
        "printf 'ran clean oracle replay' > oracle-side-effect.txt",
        "if [ \"$value\" != \"fixed\" ]; then",
        "  echo \"expected fixed, got $value\" >&2",
        "  exit 1",
        "fi",
        "echo isolated oracle passed",
      ].join("\n") + "\n",
      "utf8",
    );
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "side effect oracle fixture"], { cwd: dir });

    await writeFile(path.join(dir, "src", "value.txt"), "fixed\n", "utf8");
    await writeFile(path.join(dir, "tests", "acceptance.sh"), "echo polluted local pass\n", "utf8");

    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["tests/acceptance.sh"] }]);
    const item = commandItem({
      expectedEvidence: "trusted acceptance oracle passes",
      requiredEvidenceOrigin: "user_required",
      sourceRefs: [{ kind: "document", locator: "tests/acceptance.sh:1" }],
    });
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123", diffHash: "sha256:d" } });

    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 0);
    assert.equal(obs.cleanOracleReplayPassed, true);
    assert.equal(obs.cleanOracleReplayMode, "isolated_worktree");
    assert.equal(obs.cleanOracleReplayIsolated, true);
    assert.match(String(obs.cleanOracleReplayStdoutTail), /isolated oracle passed/);
    assert.equal(await readFile(path.join(dir, "tests", "acceptance.sh"), "utf8"), "echo polluted local pass\n");
    await assert.rejects(
      () => readFile(path.join(dir, "oracle-side-effect.txt"), "utf8"),
      /ENOENT/,
    );
    const overlayFiles = obs.cleanOracleReplayOverlayFiles as LooseRecord[];
    assert.ok(overlayFiles.some((entry) => entry.file === "src/value.txt" && entry.action === "copy"));
    assert.ok(!overlayFiles.some((entry) => entry.file === "tests/acceptance.sh"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clean oracle replay reports retained ownership when the probe replaces its temporary root", async () => {
  const dir = await makeGitRepo();
  let canonicalRoot = "";
  try {
    await mkdir(path.join(dir, "tests"), { recursive: true });
    await writeFile(
      path.join(dir, "tests", "acceptance.sh"),
      [
        "case \"$PWD\" in",
        "  *cpb-clean-oracle-replay-*/worktree)",
        "    root=${PWD%/worktree}",
        "    mv \"$root\" \"$root.owned\"",
        "    mkdir -p \"$root/worktree\"",
        "    printf 'successor\\n' > \"$root/successor.txt\"",
        "    ;;",
        "esac",
        "echo isolated hostile replay completed",
      ].join("\n") + "\n",
      "utf8",
    );
    await exec("git", ["add", "tests/acceptance.sh"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "add hostile cleanup oracle"], { cwd: dir });
    await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: "sh", args: ["tests/acceptance.sh"] }]);
    await writeFile(path.join(dir, "tests", "acceptance.sh"), "echo polluted local pass\n", "utf8");

    const item = commandItem({
      expectedEvidence: "trusted acceptance oracle passes",
      requiredEvidenceOrigin: "user_required",
      sourceRefs: [{ kind: "document", locator: "tests/acceptance.sh:1" }],
    });
    const checks = await runChecklistProbes(checklist([item]), dir, {
      finalWorktree: { head: "abc123", diffHash: "sha256:d" },
    });
    const obs = checks[0].observation;
    assert.equal(obs.exitCode, 0);
    assert.equal(obs.cleanOracleReplayPassed, false);
    assert.match(String(obs.cleanOracleReplayReason), /cleanup.*authority|authority.*cleanup/i);
    const cleanup = obs.cleanOracleReplayCleanup as LooseRecord;
    assert.equal(cleanup.committed, false);
    assert.equal(cleanup.disposition, "retained");
    assert.equal(cleanup.successorPreserved, true);
    const recoveryPaths = cleanup.recoveryPaths as LooseRecord;
    canonicalRoot = String(recoveryPaths.canonicalRoot || "");
    assert.match(canonicalRoot, /cpb-clean-oracle-replay-/);
    assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "successor\n");
    assert.equal(await readFile(path.join(`${canonicalRoot}.owned`, "worktree", "tests", "acceptance.sh"), "utf8").then((value) => value.includes("isolated hostile replay completed")), true);
  } finally {
    if (canonicalRoot) {
      await rm(canonicalRoot, { recursive: true, force: true });
      await rm(`${canonicalRoot}.owned`, { recursive: true, force: true });
    }
    await exec("git", ["worktree", "prune", "--expire", "now"], { cwd: dir }).catch(() => null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("command item with no declared command -> honest fail, never a silent skip", async () => {
  const dir = await makeGitRepo();
  try {
    // No expectedEvidence, no probeCommand.
    const item = commandItem({});
    const checks = await runChecklistProbes(checklist([item]), dir, {});
    assert.equal(checks.length, 1, "must emit a claim, not silently drop");
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "command");
    assert.equal(checks[0].emitFailedClaim, true);
    assert.match(String(obs.note), /no trusted structured probe/);
    assert.equal(obs.command, undefined);
    assert.equal(obs.exitCode, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("free-text expectedEvidence is never executed without a trusted HEAD policy entry", async () => {
  const dir = await makeGitRepo();
  try {
    const marker = path.join(dir, "free-text-command-ran");
    const item = commandItem({ expectedEvidence: `printf compromised > ${marker}` });
    const checks = await runChecklistProbes(checklist([item]), dir, {});
    assert.equal(checks.length, 1);
    assert.match(String(checks[0].observation.note), /free-text evidence was not executed/);
    await assert.rejects(() => readFile(marker, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted command probes receive a scrubbed environment", async () => {
  const fixture = new URL("./fixtures/probe-runner-ambient-scrub-fixture.js", import.meta.url);
  const result = await execJson(process.execPath, [fixture.pathname], {
    env: {
      ...process.env,
      CPB_HUB_TOKEN: "ambient-secret-must-not-reach-child",
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.secretPresent, false);
  assert.equal(result.stdoutTail, "environment scrubbed\n");
});

test("trusted command probes prefer explicit job env over conflicting ambient allowlist values", async () => {
  const fixture = new URL("./fixtures/probe-runner-explicit-env-fixture.js", import.meta.url);
  const result = await execJson(process.execPath, [fixture.pathname], {
    env: {
      ...process.env,
      CPB_ORIGINAL_PATH: process.env.PATH || "",
      HOME: "/cpb-ambient-home",
      PATH: `/cpb-ambient-bin:${process.env.PATH || ""}`,
      USER: "cpb-ambient-user",
      GIT_DIR: "/tmp/cpb-ambient-bad-git-dir",
      CPB_HUB_TOKEN: "ambient-hub-secret-must-not-reach-child",
      OPENAI_API_KEY: "ambient-openai-secret-must-not-reach-child",
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.home, "/cpb-job-home");
  assert.match(String(result.path), /^\/cpb-job-bin:/);
  assert.equal(result.user, "cpb-job-user");
  assert.equal(result.ci, "1");
  assert.equal(result.secretPresent, false);
  assert.equal(result.ambientLeakPresent, false);
  assert.equal(result.ambientGitDirWasSet, true);
  assert.equal(typeof result.pythonpath, "string");
});

test("concurrent trusted command probes keep explicit job env isolated and scrub secrets", async () => {
  async function runJob(label: "alpha" | "bravo") {
    const dir = await makeGitRepo();
    const otherLabel = label === "alpha" ? "bravo" : "alpha";
    try {
      await writeFile(
        path.join(dir, "probe-concurrent-env.mjs"),
        [
          "const secretKeys = ['CPB_HUB_TOKEN', 'OPENAI_API_KEY'];",
          "console.log(JSON.stringify({",
          "  home: process.env.HOME,",
          "  path: process.env.PATH,",
          "  user: process.env.USER,",
          "  pythonpath: process.env.PYTHONPATH,",
          "  secretPresent: secretKeys.some((key) => Boolean(process.env[key])),",
          "}));",
        ].join("\n") + "\n",
        "utf8",
      );
      await trustProbes(dir, [{ predicateId: "PRED-CMD", executable: process.execPath, args: ["probe-concurrent-env.mjs"] }]);
      const item = commandItem({ expectedEvidence: `${label} trusted environment isolation probe passes` });
      const env = {
        HOME: `/cpb-${label}-home`,
        PATH: `/cpb-${label}-bin:${process.env.PATH || ""}`,
        USER: `cpb-${label}-user`,
        CPB_HUB_TOKEN: `${label}-hub-secret-must-not-reach-child`,
        OPENAI_API_KEY: `${label}-openai-secret-must-not-reach-child`,
      };
      const checks = await runChecklistProbes(checklist([item]), dir, {
        finalWorktree: { head: `${label}-head` },
        env,
      });
      const obs = checks[0].observation;
      assert.equal(obs.exitCode, 0);
      const stdout = String(obs.stdoutTail);
      const parsed = JSON.parse(stdout) as LooseRecord;
      assert.deepEqual(parsed, {
        home: env.HOME,
        path: env.PATH,
        user: env.USER,
        pythonpath: dir,
        secretPresent: false,
      });
      assert.ok(!stdout.includes(env.CPB_HUB_TOKEN));
      assert.ok(!stdout.includes(env.OPENAI_API_KEY));
      assert.ok(!stdout.includes(`/cpb-${otherLabel}-home`));
      assert.ok(!stdout.includes(`/cpb-${otherLabel}-bin`));
      assert.ok(!stdout.includes(`cpb-${otherLabel}-user`));
      return { dir, stdout };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  const jobs = await Promise.all([runJob("alpha"), runJob("bravo")]);
  try {
    assert.notEqual(jobs[0].dir, jobs[1].dir);
    assert.notEqual(jobs[0].stdout, jobs[1].stdout);
  } finally {
    await Promise.all(jobs.map((job) => rm(job.dir, { recursive: true, force: true })));
  }
});

test("legacy clean-oracle fallback flag cannot escape the isolated replay", async () => {
  const fixture = new URL("./fixtures/probe-runner-clean-oracle-env-fixture.js", import.meta.url);
  const result = await execJson(process.execPath, [fixture.pathname], {
    env: {
      ...process.env,
      GIT_DIR: "/tmp/cpb-ambient-bad-git-dir",
      CPB_CLEAN_ORACLE_REPLAY_ACTIVE_FALLBACK: "1",
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanOracleReplayPassed, false);
  assert.equal(result.cleanOracleReplayMode, "isolated_worktree");
  assert.equal(result.cleanOracleReplayFallbackFrom, undefined);
  assert.equal(result.ambientGitDirWasSet, true);
});

test("runtime_event item -> honest fail claim (not silently dropped), ledger-visible", async () => {
  const dir = await makeGitRepo();
  try {
    const item = runtimeEventItem();
    const checks = await runChecklistProbes(checklist([item]), dir, { finalWorktree: { head: "abc123" } });
    assert.equal(checks.length, 1, "runtime_event must be recorded, not dropped");
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "runtime_event");
    assert.equal(checks[0].emitFailedClaim, true);
    assert.match(String(obs.note), /no deterministic probe yet/);
    // Not valid for satisfaction (no payload matcher) — an honest fail.
    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.satisfied, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing static behavior unchanged: matchCount semantics preserved", async () => {
  const dir = await makeGitRepo();
  try {
    await writeFile(path.join(dir, "README.md"), "# changed\n", "utf8");
    const item = staticItem();
    const checks = await runChecklistProbes(checklist([item]), dir, {});
    assert.equal(checks.length, 1);
    const obs = checks[0].observation;
    assert.equal(obs.verificationMethod, "static");
    assert.match(obs.queryId, /^static-diff-scope:AC-STATIC$/);
    assert.ok(Number.isInteger(obs.matchCount) && obs.matchCount > 0);
    assert.deepEqual(obs.changedFilesInScope, ["README.md"]);
    assert.equal(checks[0].emitFailedClaim, true);

    const v = validateEvidenceObservation(obs, item, { attemptId: "" });
    assert.equal(v.valid, true);
    assert.equal(v.satisfied, true);

    // And the static miss case still yields an honest fail (matchCount 0).
    await exec("git", ["checkout", "-q", "--", "README.md"], { cwd: dir });
    await writeFile(path.join(dir, "OTHER.md"), "x\n", "utf8");
    const checks2 = await runChecklistProbes(checklist([staticItem({ id: "AC-STATIC-2", predicateId: "PRED-STATIC-2" })]), dir, {});
    assert.equal(checks2[0].observation.matchCount, 0);
    const v2 = validateEvidenceObservation(checks2[0].observation, staticItem({ id: "AC-STATIC-2", predicateId: "PRED-STATIC-2" }), { attemptId: "" });
    assert.equal(v2.valid, true);
    assert.equal(v2.satisfied, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
