import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

async function runHealthCheck(args) {
  try {
    const result = await execFileAsync(
      "node",
      ["cli/cpb.mjs", "health-check", ...args],
      {
        cwd: ROOT,
        env: { ...process.env, CPB_PORT: "9" },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return {
      code: err.code,
      signal: err.signal,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      message: err.message,
    };
  }
}

async function runCpb(args) {
  try {
    const result = await execFileAsync(
      "node",
      ["cli/cpb.mjs", ...args],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CPB_PORT: "9",
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    return {
      code: err.code,
      signal: err.signal,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      message: err.message,
    };
  }
}

describe("fake ACP local smoke", () => {
  it("runs a repeatable init/attach/pipeline/review/verify smoke through health-check", { timeout: 60_000 }, async () => {
    const result = await runHealthCheck([
      "--skip-http",
      "--skip-tests",
      "--skip-build",
      "--fake-acp-smoke",
    ]);

    assert.equal(result.code, 0, result.stdout + result.stderr + result.message);
    assert.match(result.stdout, /fake-acp-smoke/);
    assert.match(result.stdout, /PASS/);
  });

  it("runs cpb demo --json without real provider keys and leaves inspectable artifacts", { timeout: 60_000 }, async () => {
    const result = await runCpb(["demo", "--json"]);
    assert.equal(result.code, 0, result.stdout + result.stderr + result.message);

    const parsed = JSON.parse(result.stdout);
    try {
      assert.equal(parsed.ok, true);
      assert.equal(parsed.job.status, "completed");
      assert.match(parsed.project, /^demo-/);
      assert.match(parsed.sourcePath, /toy-repo/);

      const eventLog = await readFile(parsed.eventLog, "utf8");
      assert.match(eventLog, /"job_completed"/);

      const plan = await readFile(parsed.artifacts.plan.path, "utf8");
      const deliverable = await readFile(parsed.artifacts.deliverable.path, "utf8");
      const verdict = JSON.parse(await readFile(parsed.artifacts.verdict.path, "utf8"));

      assert.match(plan, /Demo Plan/);
      assert.match(deliverable, /Demo Deliverable/);
      assert.equal(verdict.status, "pass");
    } finally {
      if (parsed?.tempRoot) {
        await rm(parsed.tempRoot, { recursive: true, force: true });
      }
    }
  });
});
