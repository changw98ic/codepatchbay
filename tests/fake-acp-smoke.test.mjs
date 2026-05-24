import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promisify } from "node:util";

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
});
