import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  stabilizationChecks,
  verifyStabilization,
  type StabilizationCheck,
} from "../scripts/verify-stabilization.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function checkCommand(check: StabilizationCheck) {
  return [check.command, ...check.args].join(" ");
}

test("stabilization gate includes all required release evidence commands", () => {
  assert.deepEqual(stabilizationChecks.map(checkCommand), [
    "npm run typecheck",
    "npm run typecheck:strict:engine",
    "npm run typecheck:type-debt:engine",
    "npm run verify:dependency-audit",
    "npm run verify:patch-integrity",
    "npm run verify:release-gate",
    "npm run verify:enterprise-gate",
    "npm run verify:product-gate",
  ]);
  assert.equal(stabilizationChecks.at(-1)?.label, "product validation gate");
});

test("stabilization gate stops at the first failed command", async () => {
  const executed: string[] = [];
  const result = await verifyStabilization({
    checks: stabilizationChecks,
    run: async (check) => {
      executed.push(checkCommand(check));
      return check.args[1] !== "verify:release-gate";
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(executed, [
    "npm run typecheck",
    "npm run typecheck:strict:engine",
    "npm run typecheck:type-debt:engine",
    "npm run verify:dependency-audit",
    "npm run verify:patch-integrity",
    "npm run verify:release-gate",
  ]);
});

test("stabilization gate passes only when every required command passes", async () => {
  const result = await verifyStabilization({
    run: async () => true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, stabilizationChecks.length);
});

test("package exposes stabilization verifier entrypoint", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["verify:stabilization"],
    "npm run build && npm run build:tests && node dist/scripts/verify-stabilization.js",
  );
  assert.equal(
    pkg.scripts["verify:enterprise-gate"],
    "npm run build && npm run build:tests && node dist/scripts/verify-enterprise-gate.js",
  );
  assert.equal(
    pkg.scripts["verify:dependency-audit"],
    "npm audit --omit=dev --audit-level=moderate && npm audit --audit-level=high",
  );
});

test("CI cannot reinstall the removed web toolchain outside the reviewed lockfile", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "test.yml"), "utf8");
  assert.doesNotMatch(workflow, /\bnpx\s+playwright\b/);
  assert.doesNotMatch(workflow, /npm install @rollup\/rollup-linux-x64-gnu --no-save/);
});

test("retired orchestrator cutover fails closed without moving live state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-retired-cutover-"));
  const hubRoot = path.join(root, "hub");
  const queueRoot = path.join(hubRoot, "queue");
  const sentinel = path.join(queueRoot, "must-survive.json");
  await mkdir(queueRoot, { recursive: true });
  await writeFile(sentinel, "preserved\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync("bash", [
    path.join(repoRoot, "scripts", "cutover-orchestrator.sh"),
    hubRoot,
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is retired and did not modify Hub state/);
  assert.match(result.stderr, /cpb hub migrate-to-redis/);
  assert.equal(await readFile(sentinel, "utf8"), "preserved\n");
});

test("manual E2E cleanup requires an explicit disposable-root capability", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-guard-"));
  const hubRoot = path.join(root, "hub");
  const queueRoot = path.join(hubRoot, "queue");
  const sentinel = path.join(queueRoot, "must-survive.json");
  await mkdir(queueRoot, { recursive: true });
  await writeFile(sentinel, "preserved\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync("bash", [path.join(repoRoot, "scripts", "e2e-test.sh")], {
    encoding: "utf8",
    env: { ...process.env, CPB_HUB_ROOT: hubRoot, CPB_E2E_ALLOW_DESTRUCTIVE: "0" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CPB_E2E_ALLOW_DESTRUCTIVE=1/);
  assert.equal(await readFile(sentinel, "utf8"), "preserved\n");
});

test("interactive review rejection cannot run repository-wide destructive git commands", async () => {
  const source = await readFile(path.join(repoRoot, "cli", "commands", "review.ts"), "utf8");
  assert.doesNotMatch(source, /spawn\("git", \["-C", src, "(?:checkout|clean|reset)"/);
  assert.match(source, /Review rejected; no files were modified/);
});

test("setup guidance does not recommend piping remote installers into a shell", async () => {
  const source = await readFile(path.join(repoRoot, "cli", "commands", "setup.ts"), "utf8");
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:bash|sh)/);
  assert.match(source, /vendor's official documentation/);
});
