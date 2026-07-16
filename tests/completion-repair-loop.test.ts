import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { runJob } from "../core/engine/run-job.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import type { LooseRecord } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCb);

function jsonEnvelope(value: LooseRecord) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function plannerOutput() {
  return jsonEnvelope({
    status: "ok",
    planMarkdown: [
      "## Analysis",
      "- Update the README requirement and verify the exact candidate.",
      "",
      "## Bounded Handoff",
      "- Real actors: README.md",
      "- Entrypoints: repository documentation",
      "- Bypass candidates: verifier self-attestation",
      "- Edit files: README.md",
      "- Verification targets: objective diff probe",
      "- Blockers: none",
      "",
      "## Files to modify",
      "- README.md",
      "",
      "## Implementation Steps",
      "1. Update README.md.",
      "",
      "## Testing",
      "- Verify the diff-bound static probe.",
      "",
      "## Risks",
      "- None.",
    ].join("\n"),
  });
}

function decomposerOutput() {
  return jsonEnvelope({
    status: "ok",
    decomposedItems: [{
      requirement: "README records the trusted completion-loop behavior.",
      predicateId: "readme-completion-loop",
      verificationMethod: "static",
      allowedFiles: ["README.md"],
      sourceRefs: [{ kind: "task_text", locator: "task:0" }],
      expectedEvidence: "README.md has an objective diff in the final candidate",
    }],
  });
}

function frozenChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-completion-repair",
    project: "flow",
    status: "frozen",
    source: { task: "Record completion-loop behavior in README.md", issue: null, documents: [] },
    items: [{
      id: "AC-001",
      requirement: "README records the trusted completion-loop behavior.",
      source: "user_task",
      sourceRefs: [{ kind: "task_text", locator: "task:0" }],
      predicateId: "readme-completion-loop",
      required: true,
      area: "documentation",
      risk: "medium",
      verificationMethod: "static",
      expectedEvidence: "README.md has an objective diff in the final candidate",
      dependsOn: [],
      allowedFiles: ["README.md"],
    }],
    assumptions: [],
  };
}

function executorOutput() {
  return jsonEnvelope({
    status: "ok",
    summary: "README completion-loop requirement handled.",
    tests: ["objective static diff probe"],
    risks: [],
  });
}

function verifierOutput(evidenceId = "EV-001") {
  return jsonEnvelope({
    status: "ok",
    verdict: "pass",
    reason: "Objective evidence is cited for the frozen checklist item.",
    details: "The current candidate is bound to EV-001.",
    confidence: 1,
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-completion-repair",
      status: "pass",
      items: [{
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "pending", evidenceId }],
        actualResult: "The deterministic probe reports the README diff.",
        reason: "EV-001 is the current deterministic probe.",
        fixScope: [],
      }],
      blocking: [],
      fixScope: [],
      reason: "The frozen checklist is satisfied.",
    },
  });
}

test("completion gate evidence mismatch repairs inside the same job before terminal completion", async () => {
  const cpbRoot = await tempRoot("cpb-completion-repair-root");
  const sourcePath = await tempRoot("cpb-completion-repair-source");
  const dataRoot = path.join(cpbRoot, "runtime");
  await execFile("git", ["init"], { cwd: sourcePath });
  await execFile("git", ["config", "user.email", "cpb@example.invalid"], { cwd: sourcePath });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "completion-repair-fixture", private: true }, null, 2)}\n`, "utf8");
  await execFile("git", ["add", "README.md", "package.json"], { cwd: sourcePath });
  await execFile("git", ["commit", "-m", "fixture base"], { cwd: sourcePath });

  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const calls: LooseRecord[] = [];
  let executorCalls = 0;
  let verifierCalls = 0;
  const pool = {
    async execute(agent: string, prompt: string, cwd: string, timeoutMs: number, meta: LooseRecord) {
      if (/\bdecomposedItems\b/.test(prompt)) {
        return { output: decomposerOutput(), providerKey: agent, variant: null };
      }
      calls.push({ agent, prompt, cwd, timeoutMs, meta });
      if (meta.role === "executor") {
        executorCalls += 1;
        if (executorCalls === 2) {
          await writeFile(path.join(cwd, "README.md"), "# Fixture\n\nCompletion gate repair is bound to objective evidence.\n", "utf8");
        }
        return { output: executorOutput(), providerKey: agent, variant: null };
      }
      if (meta.role === "verifier") {
        verifierCalls += 1;
        return {
          output: verifierOutput(verifierCalls === 2 ? "EV-INVENTED" : "EV-001"),
          providerKey: agent,
          variant: null,
        };
      }
      return { output: plannerOutput(), providerKey: agent, variant: null };
    },
    async releaseWorktree() {
      return true;
    },
  };

  const appendEvent = async (_root: string, _project: string, _jobId: string, event: LooseRecord) => {
    events.push(event);
    return event;
  };
  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "Record completion-loop behavior in README.md",
    jobId: "job-completion-repair",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: { acceptanceChecklist: frozenChecklist() },
    agents: { planner: "fake-primary", executor: "fake-primary", verifier: "fake-primary" },
    createJob: async (_root: string, job: LooseRecord) => ({ ...job, status: "running" }),
    prepareTask: async () => ({
      riskMap: {
        riskLevel: "medium",
        domains: ["test_fixture"],
        highRiskFiles: [],
        safetyBoundaries: [],
        verificationDepth: "standard",
        adversarialRequired: false,
        adversarialFocus: [],
        confidence: "high",
      },
    }),
    startPhase: async () => {},
    completePhase: async () => {},
    completeJob: async (_root: string, project: string, jobId: string) => {
      events.push({ type: "job_completed", project, jobId });
    },
    failJob: async (_root: string, _project: string, _jobId: string, failure: LooseRecord) => {
      failed.push(failure);
    },
    appendEvent,
    getArtifactIndex: async (root: string, project: string, jobId: string) => (
      buildArtifactIndex(root, project, jobId, { events, dataRoot })
    ),
    getPool: () => pool,
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure));
  assert.equal(failed.length, 0, "repairable completion failure must not call failJob");
  assert.equal(executorCalls, 2, "completion failure must re-enter execute in the same job");
  assert.equal(calls.filter((call) => call.meta?.role === "verifier").length, 3);
  const executorConversations = calls
    .filter((call) => call.meta?.role === "executor")
    .map((call) => call.meta?.conversationKey);
  assert.equal(executorConversations[0], executorConversations[1]);
  assert.ok(events.some((event) => event.type === "completion_gate_repair_deferred" && event.retryPhase === "execute"));
  assert.ok(events.some((event) => event.type === "completion_gate_repair_deferred" && event.retryPhase === "verify"));
  assert.ok(events.some((event) => event.type === "solver_completion_gate_repair_started" && event.iteration === 1));
  assert.ok(events.some((event) => event.type === "solver_completion_gate_repair_started" && event.iteration === 2 && event.phase === "verify"));
  assert.ok(events.some((event) => event.type === "solver_completion_gate_repair_completed" && event.iteration === 2));
  assert.equal(events.some((event) => event.type === "solver_completion_gate_repair_exhausted"), false);

  const diff = await execFile("git", ["diff", "--", "README.md"], { cwd: sourcePath });
  assert.match(diff.stdout, /Completion gate repair is bound to objective evidence/);
});
