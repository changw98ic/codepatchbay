import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { appendEvent } from "../server/services/event/event-store.js";
import { buildJobAuditExport } from "../server/services/readiness-checks.js";
import { tempRoot } from "./helpers.js";

test("audit export includes checklist artifacts from artifact index", async () => {
  const cpbRoot = await tempRoot("cpb-audit-checklist");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });
  const artifacts = {
    "acceptance-checklist": { schemaVersion: 1, jobId: "job-audit-checklist", project: "proj", attemptId: "job-audit-checklist", status: "frozen", items: [{ id: "AC-001", required: true }] },
    "execution-map": { schemaVersion: 1, attemptId: "job-audit-checklist", mappings: [{ checklistId: "AC-001", changedFiles: ["README.md"] }], changedFiles: ["README.md"], unmappedChangedFiles: [] },
    "evidence-ledger": { schemaVersion: 1, attemptId: "job-audit-checklist", ledgerId: "evidence-ledger-001", finalWorktree: { head: "abc", diffHash: "sha256:one" }, evidence: [{ id: "EV-001", type: "evidence_claim", attemptId: "job-audit-checklist", checklistId: "AC-001", verificationMethod: "command", predicateId: "PRED-001", result: "pass", command: "npm test", exitCode: 0, stdoutSha256: "sha256:stdout", worktreeHead: "abc", diffHash: "sha256:one" }] },
    "checklist-verdict": { schemaVersion: 1, attemptId: "job-audit-checklist", status: "pass", items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], fixScope: [] }] },
  };
  for (const [kind, content] of Object.entries(artifacts)) {
    const name = `${kind}-001`;
    await writeFile(path.join(outputs, `${name}.md`), JSON.stringify(content), "utf8");
    await appendEvent(cpbRoot, "proj", "job-audit-checklist", {
      type: "artifact_created",
      jobId: "job-audit-checklist",
      project: "proj",
      phase: "verify",
      kind,
      artifactKind: kind,
      artifact: name,
      artifactId: "001",
      attemptId: "job-audit-checklist",
      ts: "2026-06-12T00:00:00Z",
    }, { dataRoot });
  }
  await appendEvent(cpbRoot, "proj", "job-audit-checklist", {
    type: "phase_poisoned_session",
    jobId: "job-audit-checklist",
    project: "proj",
    attemptId: "job-audit-checklist",
    phase: "verify",
    nodeId: "verify",
    reasons: ["provider output was poisoned"],
    classifier: "poisoned-session-v1",
    ts: "2026-06-12T00:00:01Z",
  }, { dataRoot });
  const audit = await buildJobAuditExport(cpbRoot, "proj", "job-audit-checklist", { dataRoot }) as Record<string, any>;
  assert.equal(audit.checklist.items[0].id, "AC-001");
  assert.deepEqual(audit.executionMap.changedFiles, ["README.md"]);
  assert.equal(audit.evidenceLedger.finalWorktree.diffHash, "sha256:one");
  assert.deepEqual(audit.checklistVerdict.items[0].evidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
  assert.equal(audit.runtimeFailures[0].type, "phase_poisoned_session");
  assert.equal(audit.completionGate?.checklistOutcome ?? null, null);
});
