import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "bridges", "merge-research.mjs");

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "merge-research-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("merge-research.mjs", () => {
  it("merges two successful agent outputs", () => {
    const codexFile = join(tmpDir, "codex.txt");
    const claudeFile = join(tmpDir, "claude.txt");
    const output = join(tmpDir, "out.md");

    writeFileSync(codexFile, "Codex analysis content", "utf8");
    writeFileSync(claudeFile, "Claude analysis content", "utf8");

    execFileSync("node", [
      SCRIPT,
      "--codex", codexFile, "--codex-exit", "0",
      "--claude", claudeFile, "--claude-exit", "0",
      "--task", "test task",
      "--output", output,
    ], { cwd: ROOT });

    const content = readFileSync(output, "utf8");
    assert.ok(content.includes("# Research: test task"));
    assert.ok(content.includes("## Codex Analysis"));
    assert.ok(content.includes("Codex analysis content"));
    assert.ok(content.includes("## Claude Analysis"));
    assert.ok(content.includes("Claude analysis content"));
    assert.ok(content.includes('"codex_ok": true'));
    assert.ok(content.includes('"claude_ok": true'));
  });

  it("handles one failed agent", () => {
    const codexFile = join(tmpDir, "codex.txt");
    const claudeFile = join(tmpDir, "claude.txt");
    const output = join(tmpDir, "out.md");

    writeFileSync(codexFile, "Codex output", "utf8");
    writeFileSync(claudeFile, "", "utf8");

    execFileSync("node", [
      SCRIPT,
      "--codex", codexFile, "--codex-exit", "0",
      "--claude", claudeFile, "--claude-exit", "1",
      "--task", "partial task",
      "--output", output,
    ], { cwd: ROOT });

    const content = readFileSync(output, "utf8");
    assert.ok(content.includes("## Codex Analysis"));
    assert.ok(content.includes("## Claude Analysis (FAILED)"));
    assert.ok(content.includes('"codex_ok": true'));
    assert.ok(content.includes('"claude_ok": false'));
  });

  it("handles both failed agents", () => {
    const codexFile = join(tmpDir, "codex.txt");
    const claudeFile = join(tmpDir, "claude.txt");
    const output = join(tmpDir, "out.md");

    writeFileSync(codexFile, "", "utf8");
    writeFileSync(claudeFile, "", "utf8");

    execFileSync("node", [
      SCRIPT,
      "--codex", codexFile, "--codex-exit", "1",
      "--claude", claudeFile, "--claude-exit", "1",
      "--task", "both fail",
      "--output", output,
    ], { cwd: ROOT });

    const content = readFileSync(output, "utf8");
    assert.ok(content.includes("## Codex Analysis (FAILED)"));
    assert.ok(content.includes("## Claude Analysis (FAILED)"));
    assert.ok(content.includes('"codex_ok": false'));
    assert.ok(content.includes('"claude_ok": false'));
  });

  it("exits with error when required args missing", () => {
    assert.throws(() => {
      execFileSync("node", [SCRIPT], { cwd: ROOT, stdio: "pipe" });
    });
  });
});
