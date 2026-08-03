import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const runnerPath = path.join(repoRoot, "dist-tests", "scripts", "run-node-tests.js");

async function listProfile(...args: string[]) {
  const { stdout } = await execFile(process.execPath, [runnerPath, ...args, "--list"], {
    cwd: repoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("ordinary test profiles never enumerate real-provider live E2E tests", async () => {
  for (const args of [[], ["--unit"], ["--main"]]) {
    const files = await listProfile(...args);
    assert.ok(files.length > 0, `${args.join(" ") || "default"} profile was empty`);
    assert.equal(
      files.some((file) => file.startsWith("tests/live-e2e/")),
      false,
      `${args.join(" ") || "default"} profile included a live-provider test`,
    );
  }
});

test("unit list output describes the files the fast unit profile actually runs", async () => {
  const files = await listProfile("--unit");
  assert.ok(files.includes("tests/job-projection.test.js"));
  assert.equal(files.includes("tests/job-runner.test.js"), false, "slow unit leaked into --unit --list");
  assert.equal(files.some((file) => file.startsWith("tests/integration/")), false);
});

test("live-provider tests have one explicit opt-in profile", async () => {
  const files = await listProfile("--live");
  assert.ok(files.includes("tests/live-e2e/flagship-pipeline.test.js"));
  assert.ok(files.every((file) => file.startsWith("tests/live-e2e/")));

  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["test:live"],
    "npm run build:node && npm run build:tests && node dist-tests/scripts/run-node-tests.js --live",
  );
});

test("live profile cannot be combined with an ordinary profile", async () => {
  await assert.rejects(
    execFile(process.execPath, [runnerPath, "--live", "--main", "--list"], {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    }),
    (error: unknown) => {
      const output = error && typeof error === "object"
        ? `${"stdout" in error ? String(error.stdout || "") : ""}\n${"stderr" in error ? String(error.stderr || "") : ""}`
        : String(error);
      assert.match(output, /mutually exclusive/);
      return true;
    },
  );
});
