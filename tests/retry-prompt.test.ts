import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  buildExecutePrompt,
  executorOutputTransportForAgent,
  executorWriteAllowPaths,
} from "../core/phases/execute.js";

test("Codex execute keeps native tool choice and uses ACP chat output by default", async () => {
  const prompt = await buildExecutePrompt({
    task: "Fix formatDisplayName()",
    project: "flow",
    sourceContext: {},
  }, null, { agent: "codex" });

  assert.match(prompt, /Choose the narrowest available repository lookup/);
  assert.doesNotMatch(prompt, /call it first/);
  assert.equal(executorOutputTransportForAgent("codex"), "chat");
  assert.equal(executorOutputTransportForAgent("claude"), "file");
  assert.equal(executorOutputTransportForAgent("codex", { CPB_EXECUTOR_OUTPUT_TRANSPORT: "file" }), "file");
});

test("executor write allow list keeps the worktree and structured output writable", () => {
  const cwd = path.join(path.sep, "tmp", "task-worktree");
  const outputFilePath = path.join(path.sep, "tmp", "cpb-runtime", "phase-io", "execute", "result.json");
  assert.equal(
    executorWriteAllowPaths({
      cwd,
      outputFilePath,
      configured: `${path.join(path.sep, "tmp", "caller-owned")}/*`,
    }),
    [
      `${path.join(path.sep, "tmp", "caller-owned")}/*`,
      `${cwd}/*`,
      `${path.dirname(outputFilePath)}/*`,
    ].join(","),
  );
});

test("execute retry prompt carries fingerprint, evidence, and an explicit changed strategy", async () => {
  const prompt = await buildExecutePrompt({
    task: "Fix the parser state transition",
    project: "flow",
    sourceContext: {
      retry: {
        failureKind: "verification_failed",
        failureReason: "parser remains in the wrong state",
        failureClass: "implementation_error",
        failureFingerprint: "sha256:stable-parser-failure",
        retryStrategy: "fresh_session_diagnosis",
        strategyChanged: true,
        retryClass: "verification_feedback",
        fixScope: ["src/parser.ts"],
        failureEvidence: {
          checks: [{ gate: "npm test -- parser", exitCode: 1 }],
          targetChecklistIds: ["AC-002"],
        },
        instruction: "Form a different root-cause hypothesis.",
      },
    },
  }, null);

  assert.match(prompt, /Failure class: implementation_error/);
  assert.match(prompt, /Failure fingerprint: sha256:stable-parser-failure/);
  assert.match(prompt, /Recovery strategy: fresh_session_diagnosis/);
  assert.match(prompt, /Strategy changed: yes/);
  assert.match(prompt, /Fix scope: src\/parser\.ts/);
  assert.match(prompt, /npm test -- parser/);
  assert.doesNotMatch(prompt, /costUsd|totalTokens/);
  assert.doesNotMatch(prompt, /SWE.?bench|FAIL_TO_PASS|PASS_TO_PASS|gold patch|benchmark/i);
});
