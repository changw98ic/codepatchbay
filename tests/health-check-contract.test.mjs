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
        timeout: 5_000,
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

describe("health-check CLI contract", () => {
  it("returns non-zero quickly when the configured HTTP check fails", async () => {
    const result = await runHealthCheck([
      "--url", "http://127.0.0.1:9/api/projects",
      "--http-attempts", "1",
      "--http-interval-ms", "1",
      "--skip-tests",
      "--skip-build",
    ]);

    assert.notEqual(result.signal, "SIGTERM");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /FAIL: HTTP health check failed/);
    assert.match(result.stdout, /FAIL: http/);
  });
});
