import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { scanTypeDebt } from "../scripts/type-debt-guard.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cliPath = path.resolve(import.meta.dirname, "..", "scripts", "type-debt-guard.js");

test("type debt guard allows baseline counts and reports new broad casts", async () => {
  const root = await tempRoot("cpb-type-debt-guard");
  const engineDir = path.join(root, "core", "engine");
  await mkdir(engineDir, { recursive: true });
  await writeFile(path.join(engineDir, "sample.ts"), [
    "type Local = AnyRecord;",
    "const unsafeRecord: Record<string, any> = {};",
    "const added = value as any;",
    "",
  ].join("\n"), "utf8");

  const result = await scanTypeDebt({
    root,
    scanDir: "core/engine",
    allowlist: {
      "core/engine/sample.ts": {
        "AnyRecord": 1,
        "Record<string, any>": 1,
        "as any": 0,
        "unknown as": 0,
        "@ts-ignore": 0,
        "@ts-expect-error": 0,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => ({
    path: v.path,
    pattern: v.pattern,
    allowed: v.allowed,
    actual: v.actual,
  })), [
    {
      path: "core/engine/sample.ts",
      pattern: "as any",
      allowed: 0,
      actual: 1,
    },
  ]);
});

test("type debt guard fails on debt in files missing from allowlist", async () => {
  const root = await tempRoot("cpb-type-debt-guard-missing");
  const engineDir = path.join(root, "core", "engine");
  await mkdir(engineDir, { recursive: true });
  await writeFile(path.join(engineDir, "new-module.ts"), [
    "export function unsafe(value: unknown) {",
    "  return value as any;",
    "}",
    "",
  ].join("\n"), "utf8");

  const result = await scanTypeDebt({
    root,
    scanDir: "core/engine",
    allowlist: {},
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => `${v.path}:${v.pattern}:${v.allowed}->${v.actual}`), [
    "core/engine/new-module.ts:as any:0->1",
  ]);
});

test("type debt guard fails on stale allowlist counts", async () => {
  const root = await tempRoot("cpb-type-debt-guard-stale");
  const engineDir = path.join(root, "core", "engine");
  await mkdir(engineDir, { recursive: true });
  await writeFile(path.join(engineDir, "clean-module.ts"), "export const safe = true;\n", "utf8");

  const result = await scanTypeDebt({
    root,
    scanDir: "core/engine",
    allowlist: {
      "core/engine/clean-module.ts": {
        "as any": 1,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => `${v.path}:${v.pattern}:${v.allowed}->${v.actual}`), [
    "core/engine/clean-module.ts:as any:1->0",
  ]);
});

test("type debt guard scans strict-engine workflow includes, not just core engine", async () => {
  const root = await tempRoot("cpb-type-debt-guard-strict-scope");
  await mkdir(path.join(root, "core", "engine"), { recursive: true });
  await mkdir(path.join(root, "core", "workflow"), { recursive: true });
  await writeFile(path.join(root, "core", "engine", "clean.ts"), "export const clean = true;\n", "utf8");
  await writeFile(path.join(root, "core", "workflow", "acceptance-checklist.ts"), [
    "type Legacy = AnyRecord;",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "tsconfig.strict-engine.json"), JSON.stringify({
    include: [
      "core/engine/clean.ts",
      "core/workflow/acceptance-checklist.ts",
    ],
  }, null, 2), "utf8");

  const result = await scanTypeDebt({ root, allowlist: {} });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => `${v.path}:${v.pattern}:${v.allowed}->${v.actual}`), [
    "core/workflow/acceptance-checklist.ts:AnyRecord:0->1",
  ]);
});

test("type debt guard CLI fails with nonzero exit on new engine debt", async () => {
  const root = await tempRoot("cpb-type-debt-guard-cli");
  await mkdir(path.join(root, "core", "engine"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "scripts", "type-debt-allowlist.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "core", "engine", "new-module.ts"), [
    "export function unsafe(value: unknown) {",
    "  return value as any;",
    "}",
    "",
  ].join("\n"), "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath], { cwd: root }),
    (err: any) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /Type debt guard failed/);
      assert.match(err.stderr, /core\/engine\/new-module\.ts: as any 1 > allowed 0/);
      return true;
    },
  );
});

test("CI workflow runs the engine type-debt gate", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /npm run typecheck:type-debt:engine/);
  assert.ok(
    workflow.indexOf("npm run typecheck:type-debt:engine") > workflow.indexOf("npm run typecheck:node"),
    "type-debt gate should run after the normal node typecheck",
  );
});
