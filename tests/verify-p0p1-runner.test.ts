import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { tempRoot } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const execFileAsync = promisify(execFile);
const runtimeScript = path.join(repoRoot, "dist", "scripts", "verify-p0-p1.js");

test("P0/P1 focused node tests run through run-node-tests for deterministic fake-agent env", async () => {
  const sourcePath = path.join(repoRoot, "scripts", "verify-p0-p1.ts");
  const source = await readFile(sourcePath, "utf8").catch(() => (
    readFile(path.join(process.cwd(), "scripts", "verify-p0-p1.ts"), "utf8")
  ));

  assert.match(source, /scripts\/run-node-tests\.js/);
  assert.match(source, /tests\/checklist-decompose-integration\.test\.js/);
  assert.match(source, /tests\/phase-budget-policy\.test\.js/);
  assert.match(source, /tests\/phase-retry\.test\.js/);
  assert.match(source, /tests\/provider-handoff\.test\.js/);
  assert.match(source, /tests\/provider-quota-fallback\.test\.js/);
  assert.match(source, /tests\/release-gate-runner\.test\.js/);
  assert.match(source, /tests\/swebench-batch-queue\.test\.js/);
  assert.doesNotMatch(
    source,
    /focused P0\/P1 node tests"[\s\S]*process\.execPath,\s*\["--test",\s*\.{3}focusedTests\]/,
  );
});

test("P0/P1 focused test list references existing source tests", async () => {
  const sourcePath = path.join(repoRoot, "scripts", "verify-p0-p1.ts");
  const source = await readFile(sourcePath, "utf8").catch(() => (
    readFile(path.join(process.cwd(), "scripts", "verify-p0-p1.ts"), "utf8")
  ));
  const paths = [...source.matchAll(/"tests\/[^"]+\.test\.js"/g)]
    .map((match) => match[0].slice(1, -1))
    .sort();

  assert.ok(paths.length > 0, "expected focused P0/P1 test paths");
  const missing: string[] = [];
  for (const compiledPath of paths) {
    const sourceTestPath = compiledPath.replace(/\.js$/, ".ts");
    await access(path.join(repoRoot, sourceTestPath)).catch(() => {
      missing.push(sourceTestPath);
    });
  }

  assert.deepEqual(missing, []);
  assert.match(source, /assertFocusedTestsExist/);
});

test("P0/P1 verifier stops before spawning checks when focused test files are missing", async () => {
  const root = await tempRoot("cpb-verify-p0p1-missing");
  const scriptsDir = path.join(root, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  const source = await readFile(runtimeScript, "utf8");
  const testScript = path.join(scriptsDir, "verify-p0-p1.js");
  await writeFile(
    testScript,
    source.replace("tests/setup-manifest-registry.test.js", "tests/missing-focused.test.js"),
    "utf8",
  );

  await assert.rejects(
    execFileAsync(process.execPath, [testScript], {
      cwd: root,
      timeout: 10_000,
    }),
    (error: any) => {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      assert.equal(error.code, 1);
      assert.match(output, /missing focused P0\/P1 test files/);
      assert.match(output, /tests\/missing-focused\.test\.js/);
      assert.doesNotMatch(output, /static: git diff --check/);
      assert.doesNotMatch(output, /focused P0\/P1 node tests/);
      return true;
    },
  );
});

test("P0/P1 runner self-test runs isolated from parallel focused tests", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "run-node-tests.ts"), "utf8").catch(() => (
    readFile(path.join(process.cwd(), "scripts", "run-node-tests.ts"), "utf8")
  ));

  assert.match(source, /const isolatedUnitFiles = new Set/);
  assert.match(source, /"tests\/verify-p0p1-runner\.test\.js"/);
});
