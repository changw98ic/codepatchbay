import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const sourceScript = path.join(repoRoot, "scripts", "verify-release-gate.ts");

test("release gate runner refuses decomposition-disabled environments and bypasses run-node-tests", async () => {
  const source = await readFile(sourceScript, "utf8");
  assert.match(source, /CPB_CHECKLIST_DECOMPOSE/);
  assert.doesNotMatch(source, /run-node-tests\.js/);
  assert.match(source, /dist-tests\/tests\/checklist-decompose-integration\.test\.js/);
  assert.match(source, /dist-tests\/tests\/completion-gate-runner\.test\.js/);
  assert.match(source, /dist-tests\/tests\/auto-finalizer\.test\.js/);
  assert.match(source, /dist-tests\/tests\/github-draft-pr\.test\.js/);
  assert.match(source, /dist\/tests\/integration\/managed-worker\.test\.js/);
  assert.match(source, /default checklist decomposition runs inside the worker path/);
  assert.match(source, /writes dry-run PR preview after evidence-backed fake ACP run/);
  assert.match(source, /--test-name-pattern/);

  await assert.rejects(
    execFileAsync(process.execPath, ["--experimental-strip-types", sourceScript], {
      cwd: repoRoot,
      env: { ...process.env, CPB_CHECKLIST_DECOMPOSE: "0" },
    }),
    (err: any) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /CPB_CHECKLIST_DECOMPOSE=0 is not allowed/);
      return true;
    },
  );
});
