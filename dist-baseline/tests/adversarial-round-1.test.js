/**
 * Adversarial Round 1: acceptance-checklist artifact file has invalid JSON (truncated).
 *
 * The completion gate MUST fail with artifact_invalid when the
 * acceptance-checklist artifact file on disk contains broken/truncated JSON
 * that cannot be parsed.
 *
 * Two attack vectors are tested:
 *   1. Pure gate:  when readActiveChecklistArtifacts silently swallows the
 *                  parse error and returns an empty object, the gate falls
 *                  back to the legacy verdict path. For a mutating job with
 *                  no parsedVerdict, gate 3 fires artifact_invalid.
 *   2. Integration: write a truncated acceptance-checklist file to disk,
 *                    call readActiveChecklistArtifacts, confirm the artifact
 *                    is silently dropped, then confirm the gate rejects.
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
test("adversarial round 1: truncated acceptance-checklist JSON causes artifact_invalid via legacy fallback", () => {
    // Simulates the real-world scenario: readActiveChecklistArtifacts catches
    // the JSON.parse error and returns {} — so checklist is undefined, and the
    // gate falls through to the legacy verdict gates. A mutating job with no
    // parsedVerdict hits gate 3: artifact_invalid.
    const result = evaluateCompletionGate({
        job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
        workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
        parsedVerdict: null,
        checklist: null,
        checklistVerdict: null,
        evidenceLedger: null,
        executionMap: null,
    });
    assert.strictEqual(result.outcome, "artifact_invalid", `expected artifact_invalid but got ${result.outcome}: ${result.reason}`);
    assert.ok(result.missingGates.includes("verdict_artifact"), `expected missingGates to include 'verdict_artifact', got: ${JSON.stringify(result.missingGates)}`);
});
// ─── Integration: truncated file on disk → artifact silently dropped ───────
test("adversarial round 1: readActiveChecklistArtifacts silently drops truncated JSON file", async () => {
    const cpbRoot = await tempRoot("cpb-adversarial-round1");
    const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
    const outputs = path.join(dataRoot, "wiki", "outputs");
    await mkdir(outputs, { recursive: true });
    // Write a truncated acceptance-checklist JSON (cut off mid-object)
    const truncatedJson = `{"schemaVersion":1,"jobId":"job-1","project":"flow","status":"frozen","items":[{"id":"AC-001","requirement":"test","source":"user_task","sourceRefs":[{"kind":"task_text","locator":"task:0}];`;
    // This is intentionally broken — the JSON cuts off before the closing braces
    // and the sourceRefs array is not properly closed.
    await writeFile(path.join(outputs, "acceptance-checklist-001.md"), truncatedJson, "utf8");
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
    const checklistEntry = index.entries.find((e) => e.kind === "acceptance-checklist");
    assert.ok(checklistEntry, "artifact index should list the acceptance-checklist entry");
    assert.strictEqual(checklistEntry.exists, true, "file exists on disk");
    // But readActiveChecklistArtifacts should silently drop it because JSON.parse fails
    const artifactIndex = await buildArtifactIndex(cpbRoot, "flow", "job-1", { dataRoot });
    const artifacts = await readActiveChecklistArtifacts({
        artifactIndex,
        attemptId: "job-1",
        requiredKinds: ["acceptance-checklist"],
    });
    assert.strictEqual(artifacts["acceptance-checklist"], undefined, "readActiveChecklistArtifacts must not return broken JSON as a parsed object");
});
// ─── Integration: truncated file + gate evaluation = artifact_invalid ──────
test("adversarial round 1: full flow — truncated checklist file leads to artifact_invalid gate", async () => {
    const cpbRoot = await tempRoot("cpb-adversarial-round1-full");
    const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
    const outputs = path.join(dataRoot, "wiki", "outputs");
    await mkdir(outputs, { recursive: true });
    // Truncated JSON — cuts off mid-value
    const truncatedJson = '{"schemaVersion":1,"jobId":"job-truncated","project":"flow","status":"frozen","items":[{"id":"AC-001","requirement":"test","source":"u';
    await writeFile(path.join(outputs, "acceptance-checklist-001.md"), truncatedJson, "utf8");
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
    // The broken artifact was silently dropped
    assert.strictEqual(artifacts["acceptance-checklist"], undefined);
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
    assert.strictEqual(result.outcome, "artifact_invalid", `gate must fail with artifact_invalid, got: ${result.outcome} — ${result.reason}`);
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
    assert.strictEqual(artifacts["acceptance-checklist"], undefined, "empty file must not produce a parsed artifact");
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
    assert.strictEqual(artifacts["acceptance-checklist"], undefined, "incomplete JSON '{' must not produce a parsed artifact");
    const result = evaluateCompletionGate({
        job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
        workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
        parsedVerdict: null,
        checklist: artifacts["acceptance-checklist"] || null,
    });
    assert.strictEqual(result.outcome, "artifact_invalid");
});
