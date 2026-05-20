#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allocateArtifactId,
  planFilePath,
  deliverableFilePath,
  verdictFilePath,
  reviewFilePath,
  repairFilePath,
  wikiLogPath,
  dashboardPath,
} from "../server/services/artifact-locator.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-artifact-loc-"));
const inboxDir = path.join(root, "wiki", "projects", "demo", "inbox");

// Path helpers
assert.equal(planFilePath(root, "demo", "001"), path.join(root, "wiki", "projects", "demo", "inbox", "plan-001.md"));
assert.equal(deliverableFilePath(root, "demo", "001"), path.join(root, "wiki", "projects", "demo", "outputs", "deliverable-001.md"));
assert.equal(verdictFilePath(root, "demo", "001"), path.join(root, "wiki", "projects", "demo", "outputs", "verdict-001.md"));
assert.equal(reviewFilePath(root, "demo", "001"), path.join(root, "wiki", "projects", "demo", "outputs", "review-001.md"));
assert.equal(repairFilePath(root, "demo", "001"), path.join(root, "wiki", "projects", "demo", "outputs", "repair-001.md"));
assert.equal(wikiLogPath(root, "demo"), path.join(root, "wiki", "projects", "demo", "log.md"));
assert.equal(dashboardPath(root, "demo"), path.join(root, "wiki", "system", "dashboard.md"));
console.log("Path helpers: OK");

// allocateArtifactId - sequential
const id1 = await allocateArtifactId(inboxDir, "plan");
assert.equal(id1, "001");
const id2 = await allocateArtifactId(inboxDir, "plan");
assert.equal(id2, "002");
const id3 = await allocateArtifactId(inboxDir, "plan");
assert.equal(id3, "003");
console.log("allocateArtifactId (sequential): OK");

// Verify placeholder files exist
assert.ok(existsSync(path.join(inboxDir, "plan-001.md")));
assert.ok(existsSync(path.join(inboxDir, "plan-002.md")));
assert.ok(existsSync(path.join(inboxDir, "plan-003.md")));
console.log("Placeholder files created: OK");

// allocateArtifactId - different prefix resets counter
const outputsDir = path.join(root, "wiki", "projects", "demo", "outputs");
const d1 = await allocateArtifactId(outputsDir, "deliverable");
assert.equal(d1, "001");
console.log("allocateArtifactId (different prefix): OK");

// Placeholder is empty (collision guard)
const content = await readFile(path.join(inboxDir, "plan-001.md"), "utf8");
assert.equal(content, "");
console.log("Placeholder content: OK");

// Cleanup
await rm(root, { recursive: true, force: true });
console.log("All artifact-locator tests passed.");
