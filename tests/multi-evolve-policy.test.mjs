import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkPolicy } from "../server/services/evolve-policy.js";

function makeIssue(overrides = {}) {
  return { description: "fix typo in readme", project: "my-app", sourcePath: "/tmp/fake", ...overrides };
}

test("checkPolicy allows a safe issue by default", () => {
  const result = checkPolicy(makeIssue());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
});

test("checkPolicy blocks project not in allowlist", () => {
  const result = checkPolicy(makeIssue({ project: "proj-a" }), { allowlist: ["proj-b", "proj-c"] });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("not in allowlist")));
});

test("checkPolicy passes when project is in allowlist", () => {
  const result = checkPolicy(makeIssue({ project: "proj-a" }), { allowlist: ["proj-a"] });
  assert.equal(result.allowed, true);
});

test("checkPolicy blocks secret-related descriptions", () => {
  const result = checkPolicy(makeIssue({ description: "rotate the api_key in production" }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("secrets")));
});

test("checkPolicy blocks authentication-related descriptions", () => {
  const result = checkPolicy(makeIssue({ description: "refactor the authentication middleware" }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("authentication")));
});

test("checkPolicy blocks destructive database descriptions", () => {
  const result = checkPolicy(makeIssue({ description: "drop_table legacy_users" }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("destructive")));
});

test("checkPolicy blocks migration descriptions", () => {
  const result = checkPolicy(makeIssue({ description: "run migration to add column" }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("migration")));
});

test("checkPolicy blocks public API change descriptions", () => {
  const result = checkPolicy(makeIssue({ description: "deprecate public api endpoint" }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("public API")));
});

test("checkPolicy detects dirty worktree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-policy-dirty-"));
  // Init a git repo and create an uncommitted file
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  await writeFile(path.join(dir, "clean.txt"), "initial");
  execSync("git add . && git commit -m init", { cwd: dir });
  await writeFile(path.join(dir, "dirty.txt"), "uncommitted");

  const result = checkPolicy(makeIssue({ sourcePath: dir }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes("dirty worktree")));
});

test("checkPolicy passes clean worktree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-policy-clean-"));
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  await writeFile(path.join(dir, "file.txt"), "content");
  execSync("git add . && git commit -m init", { cwd: dir });

  const result = checkPolicy(makeIssue({ sourcePath: dir }));
  assert.equal(result.allowed, true);
});

test("checkPolicy skips worktree check when requireCleanWorktree is false", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-policy-nock-"));
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  await writeFile(path.join(dir, "file.txt"), "content");
  execSync("git add . && git commit -m init", { cwd: dir });
  await writeFile(path.join(dir, "dirty.txt"), "uncommitted");

  const result = checkPolicy(makeIssue({ sourcePath: dir }), { requireCleanWorktree: false });
  assert.equal(result.allowed, true);
});

test("checkPolicy returns multiple reasons for multiple violations", () => {
  const result = checkPolicy(
    makeIssue({ description: "rotate secret tokens in production", project: "other" }),
    { allowlist: ["my-app"] },
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.length >= 2);
});
