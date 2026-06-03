import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "cli", "cpb.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CPB_ROOT: repoRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("codegraph remains the only code graph CLI command; legacy alias is removed", async () => {
  const codegraph = await runCli(["codegraph"]);
  assert.equal(codegraph.code, 0);
  assert.match(codegraph.stdout, /codegraph:/);

  const legacyAlias = `code${"rag"}`;
  const legacy = await runCli([legacyAlias]);
  assert.equal(legacy.code, 1);
  assert.match(legacy.stderr, new RegExp(`Unknown command: ${legacyAlias}`));
});
