#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  classifyDeleteRisk,
  formatDeleteBlockedMessage,
  logDeleteBlock,
} from "../bridges/delete-guard.mjs";

const root = path.resolve(import.meta.dirname, "..");
const client = path.join(root, "bridges", "acp-client.mjs");
const runner = path.join(root, "bridges", "job-runner.mjs");
const fakeAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-delete-guard.mjs");
const fakeWorktree = await mkdtemp(path.join(tmpdir(), "cpb-delete-guard-"));

// ============================================================
// 1. Classifier unit tests — blocked cases
// ============================================================

// rm -rf .git → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", ".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
  assert.equal(r.messageKey, "delete_blocked");
}

// rm -rf .git/objects → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", ".git/objects"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// rm --recursive --force .git → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["--recursive", "--force", ".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// rm -fr .git → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["-fr", ".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// rm -rf / → system_path_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", "/"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "system_path_delete");
}

// rm -rf /tmp → system_path_delete (exact match)
{
  const r = classifyDeleteRisk("rm", ["-rf", "/tmp"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "system_path_delete");
}

// rm -rf /usr → system_path_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", "/usr"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "system_path_delete");
}

// rm -rf ~ → home_recursive_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", "~"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "home_recursive_delete");
}

// rm -rf $HOME → home_recursive_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", "$HOME"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "home_recursive_delete");
}

// rm -rf ../outside → external_recursive_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", "../outside"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// rm -rf /absolute/external/path → external_recursive_delete
{
  const r = classifyDeleteRisk("rm", ["-rf", "/absolute/external/path"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// rm -rf (bare, no targets) → dangerous_rm_rf
{
  const r = classifyDeleteRisk("rm", ["-rf"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_rm_rf");
}

// git clean -fdx → dangerous_git_clean
{
  const r = classifyDeleteRisk("git", ["clean", "-fdx"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// git clean -f → dangerous_git_clean
{
  const r = classifyDeleteRisk("git", ["clean", "-f"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// git clean -df → dangerous_git_clean
{
  const r = classifyDeleteRisk("git", ["clean", "-df"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// git reset --hard → dangerous_git_reset_hard
{
  const r = classifyDeleteRisk("git", ["reset", "--hard"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_reset_hard");
}

// git reset --hard HEAD → dangerous_git_reset_hard
{
  const r = classifyDeleteRisk("git", ["reset", "--hard", "HEAD"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_reset_hard");
}

// Bulk deletion above threshold → bulk_delete_threshold
{
  const paths = Array.from({ length: 150 }, (_, i) => `file-${i}.js`);
  const r = classifyDeleteRisk("rm", ["-r", ...paths], { cwd: fakeWorktree, bulkThreshold: 100 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "bulk_delete_threshold");
  assert.equal(r.details.targetCount, 150);
}

// rm -r ../outside (recursive without force, external) → external_recursive_delete
{
  const r = classifyDeleteRisk("rm", ["-r", "../outside"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// rm --recursive /absolute/external/path → external_recursive_delete
{
  const r = classifyDeleteRisk("rm", ["--recursive", "/absolute/external/path"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// rm -r -f .git (separated short flags) → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["-r", "-f", ".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// rm --recursive --force .git (long flags) → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["--recursive", "--force", ".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// rm -r --force .git (mixed short/long) → git_dir_delete
{
  const r = classifyDeleteRisk("rm", ["-r", "--force", ".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// From subdirectory, rm -r ../../outside (escapes repo root) → blocked
{
  const subDir = path.join(fakeWorktree, "src");
  const r = classifyDeleteRisk("rm", ["-r", "../../outside"], { cwd: subDir, repoRoot: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// Non-recursive bulk deletion above threshold → bulk_delete_threshold
{
  const paths = Array.from({ length: 150 }, (_, i) => `file-${i}.js`);
  const r = classifyDeleteRisk("rm", paths, { cwd: fakeWorktree, bulkThreshold: 100 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "bulk_delete_threshold");
  assert.equal(r.details.targetCount, 150);
}

// git -C /path clean -fdx → dangerous_git_clean (global option before subcommand)
{
  const r = classifyDeleteRisk("git", ["-C", "/some/path", "clean", "-fdx"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// git -C /path reset --hard → dangerous_git_reset_hard (global option before subcommand)
{
  const r = classifyDeleteRisk("git", ["-C", "/some/path", "reset", "--hard"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_reset_hard");
}

// git --git-dir /tmp/.git clean -f → dangerous_git_clean (global option with value)
{
  const r = classifyDeleteRisk("git", ["--git-dir", "/tmp/.git", "clean", "-f"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// git --no-pager clean -fdx → dangerous_git_clean (valueless global option)
{
  const r = classifyDeleteRisk("git", ["--no-pager", "clean", "-fdx"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// git --no-pager reset --hard → dangerous_git_reset_hard (valueless global option)
{
  const r = classifyDeleteRisk("git", ["--no-pager", "reset", "--hard"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_reset_hard");
}

// Non-recursive rm .git → git_dir_delete (without recursive flag)
{
  const r = classifyDeleteRisk("rm", [".git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// Non-recursive rm .git/HEAD → git_dir_delete
{
  const r = classifyDeleteRisk("rm", [".git/HEAD"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// ============================================================
// 2. Classifier unit tests — allowed cases
// ============================================================

// rm file.js (non-recursive, local) → allowed
{
  const r = classifyDeleteRisk("rm", ["file.js"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// rm -rf ./node_modules (recursive, local, not .git) → allowed
{
  const r = classifyDeleteRisk("rm", ["-rf", "./node_modules"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// rm -rf node_modules (recursive, local, relative) → allowed
{
  const r = classifyDeleteRisk("rm", ["-rf", "node_modules"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// rm src/old-file.ts (non-recursive, local, subdirectory) → allowed
{
  const r = classifyDeleteRisk("rm", ["src/old-file.ts"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// rm -r dist build (recursive, multiple local targets) → allowed
{
  const r = classifyDeleteRisk("rm", ["-r", "dist", "build"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// git status → allowed
{
  const r = classifyDeleteRisk("git", ["status"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// git add . → allowed
{
  const r = classifyDeleteRisk("git", ["add", "."], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// git commit -m "msg" → allowed
{
  const r = classifyDeleteRisk("git", ["commit", "-m", "msg"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// git reset (soft) → allowed
{
  const r = classifyDeleteRisk("git", ["reset"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// git reset HEAD~1 → allowed
{
  const r = classifyDeleteRisk("git", ["reset", "HEAD~1"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// npm install → allowed
{
  const r = classifyDeleteRisk("npm", ["install"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// node -e "console.log('safe')" → allowed
{
  const r = classifyDeleteRisk("node", ["-e", "console.log('safe')"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// echo hello → allowed
{
  const r = classifyDeleteRisk("echo", ["hello"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// Bulk deletion at threshold boundary → allowed
{
  const paths = Array.from({ length: 100 }, (_, i) => `file-${i}.js`);
  const r = classifyDeleteRisk("rm", ["-r", ...paths], { cwd: fakeWorktree, bulkThreshold: 100 });
  assert.equal(r.allowed, true);
}

// Non-recursive bulk at threshold boundary → allowed
{
  const paths = Array.from({ length: 100 }, (_, i) => `file-${i}.js`);
  const r = classifyDeleteRisk("rm", paths, { cwd: fakeWorktree, bulkThreshold: 100 });
  assert.equal(r.allowed, true);
}

// From subdirectory, rm -r ../tests (stays inside repo root) → allowed
{
  const subDir = path.join(fakeWorktree, "src");
  const r = classifyDeleteRisk("rm", ["-r", "../tests"], { cwd: subDir, repoRoot: fakeWorktree });
  assert.equal(r.allowed, true);
}

// ============================================================
// 3. Shell string scanning tests
// ============================================================

// sh -c "rm -rf .git" → blocked
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -rf .git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// bash -c "rm -rf /" → blocked
{
  const r = classifyDeleteRisk("bash", ["-c", "rm -rf /"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "system_path_delete");
}

// zsh -c "rm -rf ~" → blocked
{
  const r = classifyDeleteRisk("zsh", ["-c", "rm -rf ~"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "home_recursive_delete");
}

// sh -c "rm -rf ../outside" → blocked
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -rf ../outside"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// sh -c "git clean -fdx" → blocked
{
  const r = classifyDeleteRisk("sh", ["-c", "git clean -fdx"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// sh -c "git reset --hard" → blocked
{
  const r = classifyDeleteRisk("sh", ["-c", "git reset --hard"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_reset_hard");
}

// sh -c "rm file.js" (non-recursive, safe) → allowed
{
  const r = classifyDeleteRisk("sh", ["-c", "rm file.js"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// sh -c "echo hello" → allowed
{
  const r = classifyDeleteRisk("sh", ["-c", "echo hello"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// sh without -c → allowed
{
  const r = classifyDeleteRisk("sh", ["script.sh"], { cwd: fakeWorktree });
  assert.equal(r.allowed, true);
}

// sh -c "rm -r -f .git" → blocked (separated short flags)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -r -f .git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "rm -r --force .git" → blocked (mixed short/long flags)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -r --force .git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "rm --recursive -f .git" → blocked (mixed long/short flags)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm --recursive -f .git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "rm --recursive --force .git" → blocked (long flags)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm --recursive --force .git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "rm -rf /tmp" → blocked (system path in shell string)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -rf /tmp"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "system_path_delete");
}

// sh -c "rm -rf /usr" → blocked (system path in shell string)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -rf /usr"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "system_path_delete");
}

// sh -c "rm -rf /absolute/external/path" → blocked (absolute external)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -rf /absolute/external/path"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// sh -c "rm -r ../outside" → blocked (recursive without force, external)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm -r ../outside"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "external_recursive_delete");
}

// sh -c "rm .git" (non-recursive, targets .git) → blocked
{
  const r = classifyDeleteRisk("sh", ["-c", "rm .git"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "rm .git; echo x" → blocked (.git followed by command separator)
{
  const r = classifyDeleteRisk("sh", ["-c", "rm .git; echo x"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "rm .git/HEAD" (non-recursive, targets .git subpath) → blocked
{
  const r = classifyDeleteRisk("sh", ["-c", "rm .git/HEAD"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "git_dir_delete");
}

// sh -c "git -C /path clean -fdx" → blocked (git global option in shell)
{
  const r = classifyDeleteRisk("sh", ["-c", "git -C /path clean -fdx"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// sh -c "git clean --force" → blocked (long force flag in shell)
{
  const r = classifyDeleteRisk("sh", ["-c", "git clean --force"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_clean");
}

// sh -c "git -C /path reset --hard" → blocked (git global option in shell)
{
  const r = classifyDeleteRisk("sh", ["-c", "git -C /path reset --hard"], { cwd: fakeWorktree });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "dangerous_git_reset_hard");
}

// ============================================================
// 4. formatDeleteBlockedMessage tests
// ============================================================

{
  const msg = formatDeleteBlockedMessage({
    allowed: false,
    reason: "git_dir_delete",
    messageKey: "delete_blocked",
  });
  assert.match(msg, /CPB blocked/);
  assert.match(msg, /reason: git_dir_delete/);
}

{
  const msg = formatDeleteBlockedMessage({
    allowed: false,
    reason: "dangerous_git_reset_hard",
    messageKey: "delete_blocked",
  });
  assert.match(msg, /git reset --hard/);
}

// ============================================================
// 5. logDeleteBlock tests
// ============================================================

{
  const lines = [];
  const sink = (msg) => { lines.push(msg); };
  logDeleteBlock("rm", ["-rf", ".git"], "/worktree", {
    allowed: false,
    reason: "git_dir_delete",
    messageKey: "delete_blocked",
  }, sink);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[delete-blocked\] /);
  const parsed = JSON.parse(lines[0].replace("[delete-blocked] ", ""));
  assert.equal(parsed.type, "delete_blocked");
  assert.equal(parsed.reason, "git_dir_delete");
  assert.equal(parsed.command, "rm");
  assert.deepEqual(parsed.args, ["-rf", ".git"]);
  assert.equal(parsed.cwd, "/worktree");
  assert.equal(parsed.messageKey, "delete_blocked");
  assert.ok(parsed.ts);
}

// logDeleteBlock truncates args beyond 10
{
  const lines = [];
  const sink = (msg) => { lines.push(msg); };
  const manyArgs = Array.from({ length: 20 }, (_, i) => `file-${i}`);
  logDeleteBlock("rm", manyArgs, "/worktree", {
    allowed: false,
    reason: "bulk_delete_threshold",
    messageKey: "delete_blocked",
  }, sink);

  const parsed = JSON.parse(lines[0].replace("[delete-blocked] ", ""));
  assert.equal(parsed.args.length, 10);
}

// ============================================================
// 6. ACP client integration tests
// ============================================================

async function runClient({ env, prompt, cwd }) {
  const cleanEnv = { ...process.env, ...env };
  if (!env.CPB_EXECUTOR_ROOT) delete cleanEnv.CPB_EXECUTOR_ROOT;
  if (!env.CPB_ROOT) delete cleanEnv.CPB_ROOT;
  if (!env.CPB_PROJECT_PATH_OVERRIDE) delete cleanEnv.CPB_PROJECT_PATH_OVERRIDE;
  if (!env.CPB_WORKER_ID) delete cleanEnv.CPB_WORKER_ID;
  if (!env.CPB_SESSION_ID) delete cleanEnv.CPB_SESSION_ID;
  const child = spawn(process.execPath, [client, "--agent", "codex", "--cwd", cwd], {
    cwd: root,
    env: cleanEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { exitCode, stdout, stderr };
}

// Agent tries rm -rf .git via terminal → blocked
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-dg-acp-blocked-"));
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: "TRY_TERMINAL_COMMAND: rm\nTRY_TERMINAL_ARGS: -rf .git",
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /blocked/);
  assert.match(stderr, /\[delete-blocked\]/);
  assert.match(stderr, /"messageKey":"delete_blocked"/);
}

// Agent tries git clean -fdx via terminal → blocked
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-dg-acp-git-clean-"));
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: 'TRY_TERMINAL_COMMAND: git\nTRY_TERMINAL_ARGS: ["clean","-fdx"]',
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /blocked/);
}

// Agent tries git reset --hard via terminal → blocked
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-dg-acp-git-reset-"));
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: 'TRY_TERMINAL_COMMAND: git\nTRY_TERMINAL_ARGS: ["reset","--hard"]',
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /blocked/);
}

// Agent runs safe command (echo) → not-blocked
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-dg-acp-safe-"));
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: "TRY_TERMINAL_COMMAND: echo\nTRY_TERMINAL_ARGS: hello",
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /not-blocked/);
}

// Agent runs rm file.js (non-recursive local) → not-blocked
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-dg-acp-rm-safe-"));
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: "TRY_TERMINAL_COMMAND: rm\nTRY_TERMINAL_ARGS: file.js",
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /not-blocked/);
}

// ============================================================
// 7. Job runner integration test
// ============================================================

{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cpb-dg-runner-blocked-"));
  const child = spawn(process.execPath, [
    runner,
    "--cpb-root", tempRoot,
    "--project", "demo",
    "--job-id", "job-dg-1",
    "--phase", "execute",
    "--script", "rm",
    "--", "-rf", ".git",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0, "job-runner should fail when delete guard blocks the command");
  assert.match(stderr, /delete-blocked|delete_blocked/);
  assert.match(stderr, /git_dir_delete/);
  assert.match(stderr, /\[delete_blocked reason=git_dir_delete\]/);
}

// Safe command through job-runner still works
{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cpb-dg-runner-safe-"));
  const child = spawn(process.execPath, [
    runner,
    "--cpb-root", tempRoot,
    "--project", "demo",
    "--job-id", "job-dg-2",
    "--phase", "plan",
    "--script", "node",
    "--", "-e", "console.log('safe command runs')",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /safe command runs/);
}

// ============================================================
// 8. Regression: existing safe commands still work
// ============================================================

const safeCommands = [
  { cmd: "node", args: ["-e", "console.log('ok')"] },
  { cmd: "npm", args: ["test"] },
  { cmd: "git", args: ["diff"] },
  { cmd: "git", args: ["log", "--oneline", "-5"] },
  { cmd: "git", args: ["-C", "/some/path", "status"] },
  { cmd: "git", args: ["-C", "/some/path", "diff"] },
  { cmd: "cat", args: ["package.json"] },
  { cmd: "ls", args: ["-la"] },
  { cmd: "cp", args: ["a.txt", "b.txt"] },
  { cmd: "mv", args: ["old.txt", "new.txt"] },
  { cmd: "mkdir", args: ["-p", "src/components"] },
  { cmd: "echo", args: ["hello world"] },
];

for (const { cmd, args } of safeCommands) {
  const r = classifyDeleteRisk(cmd, args, { cwd: fakeWorktree });
  assert.equal(r.allowed, true, `${cmd} ${args.join(" ")} should be allowed`);
}

console.log("all delete-guard tests passed");
