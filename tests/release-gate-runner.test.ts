import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const sourceScript = path.join(repoRoot, "scripts", "verify-release-gate.ts");
const runtimeScript = path.join(repoRoot, "dist", "scripts", "verify-release-gate.js");
const ciWorkflow = path.join(repoRoot, ".github", "workflows", "test.yml");
const flagshipGateDoc = path.join(repoRoot, "docs", "product", "cpb-flagship-validation-gate.md");
const packageJson = path.join(repoRoot, "package.json");
const distTestsRoot = path.join(repoRoot, "dist-tests");

test("CI installs a Linux sandbox provider before ACP tests", async () => {
  const source = await readFile(ciWorkflow, "utf8");
  assert.match(source, /apt-get install -y bubblewrap redis-server redis-tools zsh/);
  assert.match(source, /bwrap --version/);
  assert.match(source, /apparmor_restrict_unprivileged_userns/);
  assert.match(source, /apparmor_parser -r/);
  assert.match(source, /--ro-bind-try \/usr \/usr/);
  assert.match(source, /--bind-try "\$smoke_root" "\$smoke_root"/);
  assert.match(source, /\/bin\/zsh -c 'true'/);
  assert.doesNotMatch(source, /--ro-bind \/ \/|--ro-bind-try \/ \/|--bind \/ \/|--bind-try \/ \/|--dev-bind \/ \/|--dev-bind-try \/ \/|--overlay-src \/(?:\s|$)/);
});

test("release gate runner refuses decomposition-disabled environments and bypasses run-node-tests", async () => {
  const source = await readFile(sourceScript, "utf8");
  assert.match(source, /CPB_CHECKLIST_DECOMPOSE/);
  assert.doesNotMatch(source, /run-node-tests\.js/);
  assert.match(source, /dist-tests\/tests\/checklist-decompose-integration\.test\.js/);
  assert.match(source, /dist-tests\/tests\/completion-gate-runner\.test\.js/);
  assert.match(source, /dist-tests\/tests\/auto-finalizer\.test\.js/);
  assert.match(source, /dist-tests\/tests\/github-draft-pr\.test\.js/);
  assert.match(source, /dist-tests\/tests\/disposable-draft-pr-rehearsal\.test\.js/);
  assert.match(source, /dist-tests\/tests\/live-release-evidence\.test\.js/);
  assert.match(source, /dist-tests\/tests\/product-gate\.test\.js/);
  assert.match(source, /dist-tests\/tests\/release-readiness-report\.test\.js/);
  assert.match(source, /dist-tests\/tests\/phase-budget-policy\.test\.js/);
  assert.match(source, /dist-tests\/tests\/swebench-batch-queue\.test\.js/);
  assert.match(source, /dist-tests\/tests\/integration\/managed-worker\.test\.js/);
  assert.match(source, /flagship issue to draft PR dry-run uses default checklist decomposition and evidence/);
  assert.match(source, /release gate: release readiness report/);
  assert.doesNotMatch(source, /default checklist decomposition runs inside the worker path\|writes dry-run PR preview/);
  assert.match(source, /--test-name-pattern/);

  await assert.rejects(
    execFileAsync(process.execPath, [runtimeScript], {
      cwd: repoRoot,
      env: { ...process.env, CPB_CHECKLIST_DECOMPOSE: "0" },
    }),
    (err: any) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /CPB_CHECKLIST_DECOMPOSE=0 is not allowed/);
      return true;
    },
  );
});

test("release gate runner refuses agent-home-isolation-disabled environments", async () => {
  const source = await readFile(sourceScript, "utf8");
  assert.match(source, /CPB_AGENT_ISOLATE_HOME/);

  await assert.rejects(
    execFileAsync(process.execPath, [runtimeScript], {
      cwd: repoRoot,
      env: { ...process.env, CPB_CHECKLIST_DECOMPOSE: "1", CPB_AGENT_ISOLATE_HOME: "0" },
    }),
    (err: any) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /CPB_AGENT_ISOLATE_HOME=0 is not allowed/);
      return true;
    },
  );
});

test("test build copies runtime registry assets required by dist-tests", async () => {
  const pkg = JSON.parse(await readFile(packageJson, "utf8"));
  const buildTests = String(pkg.scripts["build:tests"] || "");

  assert.match(buildTests, /node scripts\/build-output\.mjs tests/);
  assert.doesNotMatch(buildTests, /\brm\s+-rf\b|\bfind\s+cli\b/);

  for (const relative of [
    "package.json",
    "core/agents/descriptors/codex.json",
    "core/agents/squads.json",
    "bridges/common.sh",
    "tests/fixtures/acp-client-stub.sh",
  ]) {
    assert.equal(
      await readFile(path.join(distTestsRoot, relative), "utf8"),
      await readFile(path.join(repoRoot, relative), "utf8"),
      `${relative} was not copied exactly into dist-tests`,
    );
  }

  await readFile(path.join(distTestsRoot, "scripts", "e2e-npm-pack.js"), "utf8");
  await assert.rejects(
    readFile(path.join(distTestsRoot, "scripts", "e2e-npm-pack.ts"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("flagship validation doc requires patch-integrity evidence for extracted files", async () => {
  const source = await readFile(flagshipGateDoc, "utf8");
  assert.match(source, /Patch Integrity Gate/);
  assert.match(source, /npm run verify:stabilization/);
  assert.match(source, /npm run report:release-readiness/);
  assert.match(source, /npm run verify:patch-integrity/);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --check/);
  assert.match(source, /no untracked implementation files/i);
  assert.match(source, /new files under `core\/`/);
  assert.match(source, /npm run verify:product-gate/);
  assert.match(source, /cpb-flagship-product-validation\.template\.json/);
});
