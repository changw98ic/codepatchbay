import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  formatPatchIntegrityFailure,
  parseGitStatusPorcelain,
  verifyPatchIntegrityStatus,
} from "../scripts/verify-patch-integrity.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cliPath = path.resolve(import.meta.dirname, "..", "scripts", "verify-patch-integrity.js");

test("patch integrity parses porcelain status and flags untracked implementation files", () => {
  const statusOutput = [
    "?? core/engine/new-helper.ts",
    "?? dist/generated.js",
    "?? docs/product/new-gate.md",
    " M core/engine/run-job.ts",
  ].join("\0") + "\0";

  assert.deepEqual(parseGitStatusPorcelain(statusOutput), [
    { status: "??", path: "core/engine/new-helper.ts" },
    { status: "??", path: "dist/generated.js" },
    { status: "??", path: "docs/product/new-gate.md" },
    { status: " M", path: "core/engine/run-job.ts" },
  ]);

  const result = verifyPatchIntegrityStatus(statusOutput);
  assert.equal(result.ok, false);
  assert.deepEqual(result.untrackedImplementationFiles, [
    "core/engine/new-helper.ts",
    "docs/product/new-gate.md",
  ]);
});

test("patch integrity passes when untracked files are outside reviewed implementation roots", () => {
  const result = verifyPatchIntegrityStatus([
    "?? dist/generated.js",
    "?? tmp/local-note.txt",
    " M core/engine/run-job.ts",
  ].join("\0") + "\0");

  assert.equal(result.ok, true);
  assert.deepEqual(result.untrackedImplementationFiles, []);
});

test("patch integrity CLI fails before review when source files are untracked", async () => {
  const root = await tempRoot("cpb-patch-integrity");
  await execFileAsync("git", ["init"], { cwd: root });
  await mkdir(path.join(root, "core", "engine"), { recursive: true });
  await writeFile(path.join(root, "core", "engine", "new-module.ts"), "export const value = 1;\n", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath], {
      cwd: root,
      timeout: 30_000,
    }),
    (error: any) => {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      assert.equal(error.code, 1);
      assert.match(output, /Patch integrity failed/);
      assert.match(output, /core\/engine\/new-module\.ts/);
      assert.match(output, /git status --short --untracked-files=all/);
      return true;
    },
  );
});

test("patch integrity failure message lists actionable files", () => {
  assert.match(
    formatPatchIntegrityFailure(["core/engine/extracted.ts"]),
    /core\/engine\/extracted\.ts/,
  );
});
