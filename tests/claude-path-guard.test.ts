import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { tempRoot } from "./helpers.js";

const guardScript = fileURLToPath(new URL("../scripts/claude-path-guard.js", import.meta.url));

function guard(root: string, filePath: string, extraRoots: string[] = []) {
  const result = spawnSync(process.execPath, [guardScript, root, ...extraRoots], {
    encoding: "utf8",
    input: JSON.stringify({
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    }),
  });
  assert.ok(result.status === 0 || result.status === 2, result.stderr);
  return { status: result.status, ...JSON.parse(result.stdout).hookSpecificOutput };
}

function guardBash(root: string, command: string) {
  const result = spawnSync(process.execPath, [guardScript, root], {
    encoding: "utf8",
    input: JSON.stringify({
      cwd: root,
      tool_name: "Bash",
      tool_input: { command },
    }),
  });
  assert.ok(result.status === 0 || result.status === 2, result.stderr);
  return { status: result.status, ...JSON.parse(result.stdout).hookSpecificOutput };
}

test("Claude path guard allows existing and new paths inside the worktree", async () => {
  const root = await tempRoot("cpb-claude-path-guard");
  assert.deepEqual(guard(root, path.join(root, "src", "new-file.ts")), {
    status: 0,
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "CPB path guard approved an operation inside an isolated write root",
  });
});

test("Claude path guard denies absolute paths outside the worktree", async () => {
  const root = await tempRoot("cpb-claude-path-guard-outside");
  const result = guard(root, path.join(os.homedir(), ".ssh", "config"));
  assert.equal(result.status, 2);
  assert.equal(result.permissionDecision, "deny");
});

test("Claude path guard allows only the declared isolated phase-output root outside the worktree", async () => {
  const root = await tempRoot("cpb-claude-path-guard-output-worktree");
  const runtimeRoot = await tempRoot("cpb-claude-path-guard-output-runtime");
  const allowedOutput = path.join(runtimeRoot, "phase-io", "execute");
  const target = path.join(allowedOutput, "execution.json");
  assert.equal(guard(root, target, [allowedOutput]).permissionDecision, "allow");
  const denied = guard(root, path.join(runtimeRoot, "secrets.json"), [allowedOutput]);
  assert.equal(denied.status, 2);
  assert.equal(denied.permissionDecision, "deny");
});

test("Claude path guard resolves symlink ancestors before allowing a new file", async () => {
  const root = await tempRoot("cpb-claude-path-guard-symlink");
  const outside = await tempRoot("cpb-claude-path-guard-target");
  await mkdir(path.join(root, "src"), { recursive: true });
  await symlink(outside, path.join(root, "src", "escape"));
  const denied = guard(root, path.join(root, "src", "escape", "new-file.ts"));
  assert.equal(denied.status, 2);
  assert.equal(denied.permissionDecision, "deny");
});

test("Claude command guard rejects whole-filesystem find but allows worktree searches", async () => {
  const root = await tempRoot("cpb-claude-command-guard");
  const denied = guardBash(root, "find / -name package.json");
  assert.equal(denied.status, 2);
  assert.equal(denied.permissionDecision, "deny");
  assert.match(String(denied.permissionDecisionReason), /whole-filesystem find/);

  const allowed = guardBash(root, "find . -name package.json");
  assert.equal(allowed.status, 0);
  assert.equal(allowed.permissionDecision, "allow");
});
