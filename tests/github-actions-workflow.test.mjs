import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "test.yml");

test("CI workflow opts GitHub JavaScript actions into the Node 24 runtime", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const actionRefs = Array.from(workflow.matchAll(/uses:\s*(actions\/(?:checkout|setup-node)@v(\d+))/g));

  assert.equal(actionRefs.length, 4);
  for (const [, ref, major] of actionRefs) {
    assert.ok(Number.parseInt(major, 10) >= 6, `${ref} should target the Node 24 action runtime`);
  }
  assert.doesNotMatch(
    workflow,
    /ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION:\s*["']?true["']?/,
    "CI should not suppress the warning by opting back into the deprecated Node 20 action runtime",
  );
});
