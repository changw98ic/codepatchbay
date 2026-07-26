/**
 * Adversarial Round 1: acceptance-checklist artifact file has invalid JSON (truncated).
 *
 * The completion gate MUST fail with artifact_invalid when the
 * acceptance-checklist artifact file on disk contains broken/truncated JSON
 * that cannot be parsed.
 *
 * Two attack vectors are tested:
 *   1. Pure gate: a mutating job without a parsed verdict is rejected.
 *   2. Artifact loading: truncated, empty, incomplete, or missing required
 *      artifacts return an explicit artifact_invalid result.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import { readActiveChecklistArtifacts } from "../core/workflow/checklist-artifacts.js";
import { tempRoot } from "./helpers.js";

// ─── Pure gate: truncated acceptance-checklist JSON → artifact_invalid ─────

test("adversarial round 1: a mutating job without a verdict fails closed", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: null,
    checklist: null,
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });
  assert.strictEqual(result.outcome, "artifact_invalid",
    `expected artifact_invalid but got ${result.outcome}: ${result.reason}`);
  assert.ok(result.missingGates.includes("verdict_artifact"),
    `expected missingGates to include 'verdict_artifact', got: ${JSON.stringify(result.missingGates)}`);
});

// ─── Integration: truncated file on disk → artifact fails closed ───────

test("adversarial round 1: readActiveChecklistArtifacts fails closed on truncated JSON file", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round1");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });

  // Write a truncated acceptance-checklist JSON (cut off mid-object)
  const truncatedJson = `{"schemaVersion":1,"jobId":"job-1","project":"flow","status":"frozen","items":[{"id":"AC-001","requirement":"test","source":"user_task","sourceRefs":[{"kind":"task_text","locator":"task:0}];`;
  // This is intentionally broken — the JSON cuts off before the closing braces
  // and the sourceRefs array is not properly closed.

  await writeFile(
    path.join(outputs, "acceptance-checklist-001.md"),
    truncatedJson,
    "utf8",
  );

  // Register the artifact in the event store so buildArtifactIndex can find it
  await appendEvent(cpbRoot, "flow", "job-1", {
    type: "artifact_created",
    jobId: "job-1",
    project: "flow",
    phase: "prepare_task",
    kind: "acceptance-checklist",
    artifactKind: "acceptance-checklist",
    artifact: "acceptance-checklist-001",
    artifactId: "001",
    attemptId: "job-1",
    ts: "2026-06-13T00:00:00Z",
  }, { dataRoot });

  // The artifact index should list it as existing (file is on disk)
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-1", { dataRoot });
  const checklistEntry = index.entries.find((e: any) => e.kind === "acceptance-checklist");
  assert.ok(checklistEntry, "artifact index should list the acceptance-checklist entry");
  assert.strictEqual(checklistEntry.exists, true, "file exists on disk");

  // Fail-closed: readActiveChecklistArtifacts returns artifact_invalid
  const artifactIndex = await buildArtifactIndex(cpbRoot, "flow", "job-1", { dataRoot });
  const artifacts = await readActiveChecklistArtifacts({
    artifactIndex,
    attemptId: "job-1",
    requiredKinds: ["acceptance-checklist"],
  });

  assert.equal(artifacts.ok, false, "readActiveChecklistArtifacts must fail");
  assert.equal(artifacts.outcome, "artifact_invalid", "readActiveChecklistArtifacts must fail with artifact_invalid");
  assert.ok(String(artifacts.reason || "").includes("not valid JSON"), "failure reason must explain JSON parse failure");
});

// ─── Integration: truncated file + gate evaluation = artifact_invalid ──────

test("adversarial round 1: full flow — truncated checklist file leads to artifact_invalid gate", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round1-full");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });

  // Truncated JSON — cuts off mid-value
  const truncatedJson = '{"schemaVersion":1,"jobId":"job-truncated","project":"flow","status":"frozen","items":[{"id":"AC-001","requirement":"test","source":"u';

  await writeFile(
    path.join(outputs, "acceptance-checklist-001.md"),
    truncatedJson,
    "utf8",
  );

  await appendEvent(cpbRoot, "flow", "job-truncated", {
    type: "artifact_created",
    jobId: "job-truncated",
    project: "flow",
    phase: "prepare_task",
    kind: "acceptance-checklist",
    artifactKind: "acceptance-checklist",
    artifact: "acceptance-checklist-001",
    artifactId: "001",
    attemptId: "job-truncated",
    ts: "2026-06-13T00:00:00Z",
  }, { dataRoot });

  // Simulate what run-job.ts does: read artifacts, then evaluate gate
  const artifactIndex = await buildArtifactIndex(cpbRoot, "flow", "job-truncated", { dataRoot });
  const artifacts = await readActiveChecklistArtifacts({
    artifactIndex,
    attemptId: "job-truncated",
    requiredKinds: ["acceptance-checklist", "checklist-verdict", "evidence-ledger", "execution-map"],
  });

  // The broken artifact now fails closed and does not fall back to legacy gate logic
  assert.equal(artifacts.ok, false, "readActiveChecklistArtifacts must fail on broken JSON");
  assert.equal(artifacts.outcome, "artifact_invalid", "failed artifact parse must map to artifact_invalid");
  assert.ok(String(artifacts.reason || "").includes("not valid JSON"), "failure reason must explain parse failure");

  // Now evaluate the gate exactly as run-job.ts does
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: null,
    checklist: artifacts["acceptance-checklist"] || null,
    checklistVerdict: artifacts["checklist-verdict"] || null,
    evidenceLedger: artifacts["evidence-ledger"] || null,
    executionMap: artifacts["execution-map"] || null,
    attemptId: "job-truncated",
  });

  assert.strictEqual(result.outcome, "artifact_invalid",
    `gate must fail with artifact_invalid, got: ${result.outcome} — ${result.reason}`);
});

// ─── Edge cases with different truncation patterns ─────────────────────────

test("adversarial round 1: empty acceptance-checklist file causes gate failure", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round1-empty");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });

  // Completely empty file
  await writeFile(path.join(outputs, "acceptance-checklist-001.md"), "", "utf8");

  await appendEvent(cpbRoot, "flow", "job-empty", {
    type: "artifact_created",
    jobId: "job-empty",
    project: "flow",
    phase: "prepare_task",
    kind: "acceptance-checklist",
    artifactKind: "acceptance-checklist",
    artifact: "acceptance-checklist-001",
    artifactId: "001",
    attemptId: "job-empty",
    ts: "2026-06-13T00:00:00Z",
  }, { dataRoot });

  const artifactIndex = await buildArtifactIndex(cpbRoot, "flow", "job-empty", { dataRoot });
  const artifacts = await readActiveChecklistArtifacts({
    artifactIndex,
    attemptId: "job-empty",
    requiredKinds: ["acceptance-checklist"],
  });

  assert.equal(artifacts.ok, false, "readActiveChecklistArtifacts must fail on empty file");
  assert.equal(artifacts.outcome, "artifact_invalid", "empty file must produce artifact_invalid");
  assert.ok(String(artifacts.reason || "").includes("not valid JSON"), "empty content must explain parse failure");

  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: null,
    checklist: artifacts["acceptance-checklist"] || null,
  });

  assert.strictEqual(result.outcome, "artifact_invalid");
});

test("adversarial round 1: acceptance-checklist with only opening brace causes gate failure", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round1-brace");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });

  // Just an opening brace — valid start but incomplete JSON
  await writeFile(path.join(outputs, "acceptance-checklist-001.md"), "{", "utf8");

  await appendEvent(cpbRoot, "flow", "job-brace", {
    type: "artifact_created",
    jobId: "job-brace",
    project: "flow",
    phase: "prepare_task",
    kind: "acceptance-checklist",
    artifactKind: "acceptance-checklist",
    artifact: "acceptance-checklist-001",
    artifactId: "001",
    attemptId: "job-brace",
    ts: "2026-06-13T00:00:00Z",
  }, { dataRoot });

  const artifactIndex = await buildArtifactIndex(cpbRoot, "flow", "job-brace", { dataRoot });
  const artifacts = await readActiveChecklistArtifacts({
    artifactIndex,
    attemptId: "job-brace",
    requiredKinds: ["acceptance-checklist"],
  });

  assert.equal(artifacts.ok, false, "readActiveChecklistArtifacts must fail on incomplete JSON");
  assert.equal(artifacts.outcome, "artifact_invalid", "incomplete JSON must produce artifact_invalid");
  assert.ok(String(artifacts.reason || "").includes("not valid JSON"), "parse failure must be explicit");

  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: null,
    checklist: artifacts["acceptance-checklist"] || null,
  });

  assert.strictEqual(result.outcome, "artifact_invalid");
});

test("adversarial round 1: missing required artifact kind fails closed", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round1-missing-kind");
  const acceptancePath = path.join(cpbRoot, "acceptance-checklist-001.json");
  await writeFile(acceptancePath, JSON.stringify({ kind: "acceptance-checklist" }), "utf8");

  const artifacts = await readActiveChecklistArtifacts({
    artifactIndex: {
      entries: [
        {
          kind: "acceptance-checklist",
          id: "acceptance-checklist-001",
          attemptId: "attempt-missing",
          exists: true,
          path: acceptancePath,
          createdAt: new Date().toISOString(),
        },
      ],
    },
    attemptId: "attempt-missing",
    requiredKinds: ["acceptance-checklist", "evidence-ledger"],
  });

  assert.equal(artifacts.ok, false, "missing required kind must fail");
  assert.equal(artifacts.outcome, "artifact_invalid", "missing required kind should map to artifact_invalid");
  assert.ok(
    String(artifacts.reason || "").includes("evidence-ledger"),
    "failure reason should mention the missing kind",
  );
});
