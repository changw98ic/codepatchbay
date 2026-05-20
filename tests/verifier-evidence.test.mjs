#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectCurrentDiff,
  collectUncommittedDiff,
  collectEventLog,
  collectProjectContext,
  collectDeliverable,
  collectVerifierEvidence,
} from "../server/services/verifier-evidence.js";
import { createJob, startPhase, completePhase } from "../server/services/job-store.js";
import { wikiProjectDir, inboxDir, outputsDir, contextPath } from "../server/services/phase-locator.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-verifier-evidence-"));
const project = "evidence-test";

// Setup wiki project
const wikiDir = wikiProjectDir(root, project);
await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
await writeFile(
  path.join(wikiDir, "project.json"),
  JSON.stringify({ name: project, sourcePath: null }, null, 2),
  "utf8"
);
await writeFile(contextPath(root, project), "# Evidence Test\nTesting evidence collection.\n", "utf8");

// --- collectCurrentDiff without sourcePath ---
const noDiff = await collectCurrentDiff(null);
assert.equal(noDiff.available, false);
assert.ok(noDiff.reason);

// --- collectCurrentDiff with non-git directory ---
const nonGitDir = await mkdtemp(path.join(tmpdir(), "cpb-not-git-"));
const nonGitDiff = await collectCurrentDiff(nonGitDir);
assert.equal(nonGitDiff.available, false);

// --- collectUncommittedDiff without sourcePath ---
const noUncommitted = await collectUncommittedDiff(null);
assert.equal(noUncommitted.available, false);

// --- collectEventLog ---
const job = await createJob(root, {
  project,
  task: "Test evidence collection",
  ts: "2026-05-20T00:00:00.000Z",
});

const eventLog = await collectEventLog(root, project, job.jobId);
assert.equal(eventLog.available, true);
assert.ok(eventLog.eventCount > 0);
assert.ok(Array.isArray(eventLog.events));

// --- collectEventLog for nonexistent job ---
const noLog = await collectEventLog(root, project, "nonexistent-job");
assert.equal(noLog.available, false);

// --- collectProjectContext ---
const ctx = await collectProjectContext(root, project);
assert.equal(ctx.available, true);
assert.ok(ctx.context.includes("Evidence Test"));

const noCtx = await collectProjectContext(root, "nonexistent");
assert.equal(noCtx.available, false);

// --- collectDeliverable ---
const deliverableContent = "# Deliverable\nThis is the deliverable.\n";
await writeFile(
  path.join(outputsDir(root, project), "deliverable-001.md"),
  deliverableContent,
  "utf8"
);

const deliverable = await collectDeliverable(root, project, "001");
assert.equal(deliverable.available, true);
assert.ok(deliverable.content.includes("This is the deliverable"));

const noDeliverable = await collectDeliverable(root, project, "999");
assert.equal(noDeliverable.available, false);
assert.ok(noDeliverable.reason.includes("not found"));

const nullDeliverable = await collectDeliverable(root, project, null);
assert.equal(nullDeliverable.available, false);

// --- collectVerifierEvidence (comprehensive) ---
const evidence = await collectVerifierEvidence(root, project, job.jobId, {
  deliverableId: "001",
});

assert.ok(evidence.jobState);
assert.equal(evidence.jobState.jobId, job.jobId);

// Deliverable should be available
assert.ok(evidence.deliverable);
assert.equal(evidence.deliverable.available, true);

// Event log should be available
assert.ok(evidence.eventLog);
assert.equal(evidence.eventLog.available, true);

// Project context should be available
assert.ok(evidence.projectContext);
assert.equal(evidence.projectContext.available, true);

// Diagnostics should note what's unavailable
assert.ok(Array.isArray(evidence.diagnostics));

// --- collectVerifierEvidence without deliverable ---
const evidenceNoDeliverable = await collectVerifierEvidence(root, project, job.jobId);
assert.ok(evidenceNoDeliverable);
assert.equal(evidenceNoDeliverable.deliverable?.available, false);
assert.ok(evidenceNoDeliverable.jobState, "verifier can still get job state without deliverable");
assert.ok(evidenceNoDeliverable.eventLog?.available, "verifier can still get event log without deliverable");
assert.ok(evidenceNoDeliverable.projectContext?.available, "verifier can still get context without deliverable");

// Diagnostic should note missing deliverable
const missingDeliverableDiag = evidenceNoDeliverable.diagnostics.find(
  (d) => d.message.includes("deliverable not available")
);
assert.ok(missingDeliverableDiag, "should diagnose missing deliverable");
assert.equal(missingDeliverableDiag.level, "info", "missing deliverable is info, not error");

console.log("verifier-evidence: all tests passed");
