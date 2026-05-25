import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "test.yml");

test("CI workflow opts GitHub JavaScript actions into the Node 24 runtime", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:\s*["']?true["']?/,
    "GitHub JS actions should run on Node 24 to avoid the Node 20 action-runtime deprecation warning",
  );
  assert.doesNotMatch(
    workflow,
    /ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION:\s*["']?true["']?/,
    "CI should not suppress the warning by opting back into the deprecated Node 20 action runtime",
  );
});
