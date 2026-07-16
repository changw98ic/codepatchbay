import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { FailureKind } from "../core/contracts/failure.js";
import { runPlan } from "../core/phases/plan.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

function jsonEnvelope(data: Record<string, unknown>) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

const completeSweBenchPlanMarkdown = [
  "## Analysis",
  "- use local checkout",
  "",
  "## Bounded Handoff",
  "- Real actors: JSONField key lookups and Django queryset compilation",
  "- Entrypoints: model_fields.test_jsonfield.TestQuerying canonical tests",
  "- Bypass candidates: alternate lookup classes and backend-specific compiler paths",
  "- Edit files: django/db/models/fields/json.py",
  "- Verification targets: canonical FAIL_TO_PASS and PASS_TO_PASS commands",
  "- Blockers: none",
  "",
  "## Files to modify",
  "- django/db/models/fields/json.py",
  "",
  "## Implementation Steps",
  "1. update lookup",
  "",
  "## Testing",
  "- run canonical tests",
  "",
  "## Risks",
  "- none",
].join("\n");

test("plan prompt uses the local checkout regardless of benchmark metadata", async () => {
  const cpbRoot = await tempRoot("cpb-swebench-plan-prompt");
  const sourcePath = await tempRoot("cpb-swebench-plan-source");
  let capturedPrompt = "";

  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:django/django.git"], { cwd: sourcePath });

  const pool = {
    async execute(_agent: string, prompt: string) {
      capturedPrompt = prompt;
      return {
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: completeSweBenchPlanMarkdown,
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "swebench-django-django-13346",
    jobId: "job-django-django-13346",
    task: "Resolve this SWE-bench Verified issue without external lookup.",
    sourcePath,
    sourceContext: {
      benchmarkDataset: "SWE-bench/SWE-bench_Verified",
      benchmarkInstanceId: "django__django-13346",
    },
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "passed", result.failure?.reason);
  assert.match(capturedPrompt, /local checked-out repository/i);
  assert.match(capturedPrompt, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(capturedPrompt, /Problem-space expansion/i);
  assert.match(capturedPrompt, /Minimal repro vs real path/i);
  assert.match(capturedPrompt, /Bypass candidates/i);
  assert.match(capturedPrompt, /covers the real task path/i);
  assert.match(capturedPrompt, /Bounded Handoff/i);
  assert.doesNotMatch(capturedPrompt, /SWE-bench plan phase hard constraints/i);
  assert.doesNotMatch(capturedPrompt, /Browse the repository/i);
  assert.doesNotMatch(capturedPrompt, /https:\/\/github\.com\/django\/django/i);
});

test("benchmark metadata does not impose a special bounded-handoff gate", async () => {
  const cpbRoot = await tempRoot("cpb-swebench-plan-bounded-handoff");
  const sourcePath = await tempRoot("cpb-swebench-plan-bounded-source");

  const pool = {
    async execute() {
      return {
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: "## Analysis\n- enough words to pass generic markdown length\n\n## Files to modify\n- django/db/models/fields/json.py\n\n## Implementation Steps\n1. update lookup\n\n## Testing\n- run canonical tests\n\n## Risks\n- none",
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "swebench-django-django-13346",
    jobId: "job-django-django-13346",
    task: "Resolve this SWE-bench Verified issue without external lookup.",
    sourcePath,
    sourceContext: {
      benchmarkDataset: "SWE-bench/SWE-bench_Verified",
      benchmarkInstanceId: "django__django-13346",
    },
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "passed", result.failure?.reason);
});

test("standard full coding plan runtime requires bounded handoff", async () => {
  const cpbRoot = await tempRoot("cpb-standard-plan-bounded-handoff");
  const sourcePath = await tempRoot("cpb-standard-plan-source");

  const pool = {
    async execute() {
      return {
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: "## Analysis\n- enough words to pass generic markdown length\n\n## Files to modify\n- src/routes.js\n\n## Implementation Steps\n1. update route\n\n## Testing\n- npm test\n\n## Risks\n- none",
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-standard-plan",
    task: "Fix a coding task in a local repository.",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "artifact_invalid");
  assert.match(String(result.failure?.reason), /Bounded Handoff/);
});

test("standard full coding plan timeout becomes bounded handoff timeout with carry-forward audit evidence", async () => {
  const cpbRoot = await tempRoot("cpb-standard-plan-timeout-carry-forward");
  const sourcePath = await tempRoot("cpb-standard-plan-timeout-source");
  const auditPath = path.join(cpbRoot, "plan-audit.jsonl");
  await writeFile(auditPath, [
    JSON.stringify({ event: "agent_launch", phase: "plan" }),
    JSON.stringify({ event: "tool_call", phase: "plan", title: "Read src/router.ts", kind: "read", toolCallId: "read-1", status: "completed" }),
    JSON.stringify({ event: "tool_call", phase: "plan", title: "Search auth middleware", kind: "search", toolCallId: "search-2", status: "completed" }),
    JSON.stringify({ event: "prompt_idle_timeout", phase: "plan", timeoutMs: 120000 }),
    "",
  ].join("\n"), "utf8");

  const pool = {
    async execute() {
      throw Object.assign(
        new Error("ACP prompt idle timed out after 120000ms without activity"),
        { acpAuditFile: auditPath },
      );
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-standard-plan-timeout",
    task: "Fix a coding task in a local repository.",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT);
  assert.match(String(result.failure?.reason), /plan_bounded_handoff_timeout/);
  const carryForward = recordValue(recordValue(result.failure?.cause).handoffCarryForward);
  assert.equal(carryForward.auditFile, auditPath);
  assert.equal(carryForward.toolCallCount, 2);
  assert.equal(carryForward.readSearchCount, 2);
  assert.match(JSON.stringify(carryForward), /Read src\/router\.ts/);
  assert.match(JSON.stringify(carryForward), /prompt_idle_timeout/);
});

test("plan retry prompt renders bounded handoff carry-forward evidence", async () => {
  const cpbRoot = await tempRoot("cpb-standard-plan-retry-carry-forward");
  const sourcePath = await tempRoot("cpb-standard-plan-retry-source");
  let capturedPrompt = "";

  const pool = {
    async execute(_agent: string, prompt: string) {
      capturedPrompt = prompt;
      return {
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: completeSweBenchPlanMarkdown,
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-standard-plan-retry-carry-forward",
    task: "Fix a coding task in a local repository.",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {
      retry: {
        failureKind: FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT,
        failureReason: "plan_bounded_handoff_timeout: previous attempt timed out",
        retryClass: "bounded_handoff_timeout",
        instruction: "Reuse carry-forward evidence.",
        handoffCarryForward: {
          readSearchCount: 2,
          toolCalls: [
            { event: "tool_call", title: "Read src/router.ts", kind: "read" },
            { event: "tool_call", title: "Search auth middleware", kind: "search" },
          ],
        },
      },
    },
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "passed", result.failure?.reason);
  assert.match(capturedPrompt, /Carry-Forward Static Evidence/);
  assert.match(capturedPrompt, /Read src\/router\.ts/);
  assert.match(capturedPrompt, /Search auth middleware/);
  assert.match(capturedPrompt, /do not restart broad exploration/i);
});

test("standard full coding plan runtime accepts complete bounded handoff", async () => {
  const cpbRoot = await tempRoot("cpb-standard-plan-complete-handoff");
  const sourcePath = await tempRoot("cpb-standard-plan-complete-source");

  const pool = {
    async execute() {
      return {
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: completeSweBenchPlanMarkdown,
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-standard-plan-complete",
    task: "Fix a coding task in a local repository.",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "passed", result.failure?.reason);
});

test("direct light plan runtime does not require bounded handoff", async () => {
  const cpbRoot = await tempRoot("cpb-direct-light-plan");
  const sourcePath = await tempRoot("cpb-direct-light-source");

  const pool = {
    async execute() {
      return {
        output: jsonEnvelope({
          status: "ok",
          planMarkdown: "## Analysis\n- enough words to pass generic markdown length\n\n## Files to modify\n- src/routes.js\n\n## Implementation Steps\n1. update route\n\n## Testing\n- npm test\n\n## Risks\n- none",
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runPlan({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-direct-light-plan",
    task: "Fix a light direct task.",
    workflow: "direct",
    planMode: "light",
    sourcePath,
    sourceContext: {},
    agents: { planner: "fake" },
    pool,
  });

  assert.equal(result.status, "passed", result.failure?.reason);
});
