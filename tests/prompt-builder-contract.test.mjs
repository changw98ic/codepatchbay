import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runExecute } from "../core/phases/execute.js";
import { runPlan } from "../core/phases/plan.js";
import { runVerify } from "../core/phases/verify.js";

async function withTempProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-phase-prompt-contract-"));
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  try {
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    return await fn({ cpbRoot, sourcePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function capturePool(prompts, output) {
  return {
    async execute(_agent, prompt) {
      prompts.push(prompt);
      return output;
    },
  };
}

function assertExecutionContract(prompt) {
  assert.match(prompt, /Execution Intensity Contract/);
  assert.match(prompt, /codegraph, project code index, or context pack/);
  assert.match(prompt, /First-pass inspection budget/);
  assert.match(prompt, /task-specific acceptance probes/);
  assert.match(prompt, /Stop after producing this phase's JSON envelope/);
}

describe("prompt-builder execution intensity contract", () => {
  it("requires index-first scoped execution and task-specific probes", async () => {
    const source = await readFile(path.resolve("server/services/prompt-builder.js"), "utf8");

    assert.match(source, /Execution Intensity Contract/);
    assert.match(source, /Start with indexed lookup/);
    assert.match(source, /codegraph\/code index\/project index/);
    assert.match(source, /First-pass source inspection budget/);
    assert.match(source, /task-specific acceptance probes/);
    assert.match(source, /generic\s+\\?`npm test\\?`\s+pass is not enough/);
  });

  it("keeps the core managed phase fallback prompts index-first and scoped", async () => {
    const contract = await readFile(path.resolve("core/phases/prompt-contract.js"), "utf8");
    const plan = await readFile(path.resolve("core/phases/plan.js"), "utf8");
    const execute = await readFile(path.resolve("core/phases/execute.js"), "utf8");
    const verify = await readFile(path.resolve("core/phases/verify.js"), "utf8");

    assert.match(contract, /Start with indexed lookup/);
    assert.match(contract, /codegraph, project code index, or context pack/);
    assert.match(contract, /First-pass inspection budget/);
    assert.match(contract, /task-specific acceptance probes/);
    assert.match(plan, /phaseExecutionContract\("plan"\)/);
    assert.match(execute, /phaseExecutionContract\("execute"\)/);
    assert.match(verify, /phaseExecutionContract\("verify"\)/);
  });

  it("is present in real managed phase fallback prompts", async () => {
    await withTempProject(async ({ cpbRoot, sourcePath }) => {
      const planPrompts = [];
      const planResult = await runPlan({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-plan",
        task: "Add a focused Inbox review bundle drill-down.",
        pool: capturePool(planPrompts, `\`\`\`json
{
  "status": "ok",
  "planMarkdown": "## Analysis\\nAdd the smallest route and UI updates needed for Inbox review bundle drill-down.\\n\\n## Files to modify\\n- server/routes/inbox.js\\n- web/src/pages/Inbox.tsx\\n\\n## Implementation Steps\\n1. Return review bundle evidence from the detail endpoint.\\n2. Render the evidence in the Inbox detail panel.\\n\\n## Testing\\n- tests/inbox-routes.test.mjs covers drill-down content.\\n\\n## Risks\\n- Large artifact content may need truncation later."
}
\`\`\``),
      });

      assert.equal(planResult.status, "passed");
      assertExecutionContract(planPrompts[0]);
      assert.match(planPrompts[0], /Plan the smallest file-scoped path/);

      const executePrompts = [];
      const executeResult = await runExecute({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-execute",
        task: "Add a focused Inbox review bundle drill-down.",
        previousResults: [
          { phase: "plan", status: "passed", artifact: { kind: "plan", name: "plan-real" } },
        ],
        pool: capturePool(executePrompts, `\`\`\`json
{
  "status": "ok",
  "summary": "Updated server/routes/inbox.js and web/src/pages/Inbox.tsx for review bundle evidence.",
  "tests": ["tests/inbox-routes.test.mjs verifies review bundle drill-down"],
  "risks": ["No known risks"]
}
\`\`\``),
      });

      assert.equal(executeResult.status, "passed");
      assertExecutionContract(executePrompts[0]);
      assert.match(executePrompts[0], /Implement only the scoped plan/);

      const verifyPrompts = [];
      const verifyResult = await runVerify({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-verify",
        task: "Add a focused Inbox review bundle drill-down.",
        previousResults: [
          { phase: "execute", status: "passed", artifact: { kind: "deliverable", name: "deliverable-real" } },
        ],
        pool: capturePool(verifyPrompts, `\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "Focused acceptance probes passed.",
  "details": "tests/inbox-routes.test.mjs covers review bundle drill-down.",
  "confidence": 0.9
}
\`\`\``),
      });

      assert.equal(verifyResult.status, "passed");
      assertExecutionContract(verifyPrompts[0]);
      assert.match(verifyPrompts[0], /generic test success alone is insufficient/);
    });
  });
});
