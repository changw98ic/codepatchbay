import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildArtifactIndex } from "../server/services/artifact-index.js";
import {
  allocateArtifactId,
  buildArtifactIndex as locatorBuildArtifactIndex,
  deliverableFilePath,
  planFilePath,
  reviewFilePath,
  verdictFilePath,
} from "../server/services/artifact-locator.js";
import { tempRoot } from "./helpers.mjs";

test("artifact index returns schema envelope and required entry fields", async () => {
  const root = await tempRoot("cpb-artifact-index-fields");
  const wikiDir = path.join(root, "wiki", "projects", "proj");
  const outputs = path.join(wikiDir, "outputs");
  await mkdir(outputs, { recursive: true });
  const content = "## Deliverable\nhello world\n";
  await writeFile(path.join(outputs, "deliverable-001.md"), content, "utf8");

  const index = await buildArtifactIndex(root, "proj", "job-001", {
    wikiDir,
    events: [{
      type: "phase_completed",
      phase: "execute",
      artifact: "deliverable-001.md",
      agent: "claude",
      ts: "2026-06-04T10:00:00.000Z",
    }],
  });

  assert.equal(index.schemaVersion, 1);
  assert.equal(index.project, "proj");
  assert.equal(index.jobId, "job-001");
  assert.ok(index.generatedAt);
  assert.equal(index.entries.length, 1);
  const entry = index.entries[0];
  assert.equal(entry.id, "deliverable-001");
  assert.equal(entry.kind, "deliverable");
  assert.equal(entry.phase, "execute");
  assert.equal(entry.producerAgent, "claude");
  assert.equal(entry.createdAt, "2026-06-04T10:00:00.000Z");
  assert.equal(entry.exists, true);
  assert.equal(entry.broken, false);
  assert.equal(entry.sha256, createHash("sha256").update(content).digest("hex"));
});

test("artifact index reports missing files as broken references and deduplicates entries", async () => {
  const root = await tempRoot("cpb-artifact-index-broken");
  const index = await buildArtifactIndex(root, "proj", "job-002", {
    events: [
      { type: "phase_completed", phase: "execute", artifact: "deliverable-missing.md", ts: "2026-06-04T11:00:00Z" },
      { type: "phase_retry", phase: "execute", artifact: "deliverable-missing.md", ts: "2026-06-04T11:01:00Z" },
      { type: "phase_completed", phase: "plan", artifact: "plan-gone.md", ts: "2026-06-04T09:00:00Z" },
    ],
  });
  assert.equal(index.entries.length, 2);
  assert.equal(index.brokenReferences.length, 2);
  assert.ok(index.brokenReferences.every((entry) => entry.broken && entry.sha256 === null));
});

test("artifact index infers kinds from filenames and phases", async () => {
  const root = await tempRoot("cpb-artifact-index-kinds");
  const wikiDir = path.join(root, "wiki", "projects", "proj");
  const inbox = path.join(wikiDir, "inbox");
  const outputs = path.join(wikiDir, "outputs");
  await mkdir(inbox, { recursive: true });
  await mkdir(outputs, { recursive: true });
  const cases = [
    { file: "plan-001.md", dir: inbox, phase: "plan", expected: "plan" },
    { file: "deliverable-001.md", dir: outputs, phase: "execute", expected: "deliverable" },
    { file: "review-001.md", dir: outputs, phase: "review", expected: "review" },
    { file: "verdict-001.md", dir: outputs, phase: "verify", expected: "verdict" },
    { file: "diff-001.patch", dir: outputs, phase: "execute", expected: "diff" },
    { file: "generic-output.md", dir: outputs, phase: "plan", expected: "plan" },
  ];
  for (const item of cases) {
    await writeFile(path.join(item.dir, item.file), `${item.file}\n`, "utf8");
  }

  const index = await buildArtifactIndex(root, "proj", "job-003", {
    wikiDir,
    events: cases.map((item) => ({ type: "artifact", phase: item.phase, artifact: item.file })),
  });

  for (const item of cases) {
    const entry = index.entries.find((candidate) => candidate.id === item.file.replace(/\.(?:md|patch)$/, ""));
    assert.equal(entry?.kind, item.expected, item.file);
  }
});

test("artifact locator keeps legacy path helpers and re-exports buildArtifactIndex", async () => {
  assert.equal(planFilePath("/opt/cpb", "my-proj", "042"), "/opt/cpb/wiki/projects/my-proj/inbox/plan-042.md");
  assert.equal(deliverableFilePath("/opt/cpb", "my-proj", "042"), "/opt/cpb/wiki/projects/my-proj/outputs/deliverable-042.md");
  assert.equal(verdictFilePath("/opt/cpb", "my-proj", "042"), "/opt/cpb/wiki/projects/my-proj/outputs/verdict-042.md");
  assert.equal(reviewFilePath("/opt/cpb", "my-proj", "042"), "/opt/cpb/wiki/projects/my-proj/outputs/review-042.md");
  assert.equal(locatorBuildArtifactIndex, buildArtifactIndex);

  const root = await tempRoot("cpb-artifact-id");
  const dir = path.join(root, "ids");
  const first = await allocateArtifactId(dir, "plan");
  const second = await allocateArtifactId(dir, "plan");
  assert.ok(first < second);
});
