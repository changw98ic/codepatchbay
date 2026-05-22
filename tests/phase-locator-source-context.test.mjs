#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildLocator,
  locatorEnvelope,
  wikiProjectDir,
  projectMetaPath,
  contextPath,
  decisionsPath,
} from "../server/services/phase-locator.js";
import { createJob } from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-locator-source-ctx-"));
const project = "locator-ctx";

const wikiDir = wikiProjectDir(root, project);
await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
await writeFile(
  projectMetaPath(root, project),
  JSON.stringify({ name: project, sourcePath: "/tmp/test-project" }, null, 2),
  "utf8"
);
await writeFile(contextPath(root, project), `# ${project}\n`, "utf8");
await writeFile(decisionsPath(root, project), `# ${project} Decisions\n`, "utf8");

// Job with source context
const job = await createJob(root, {
  project,
  task: "GitHub issue #63 fix",
  ts: "2026-05-21T21:00:00.000Z",
  sourceContext: {
    queueEntryId: "q-test-123",
    issueNumber: 63,
    issueUrl: "https://github.com/example/repo/issues/63",
    repo: "example/repo",
    issueTitle: "Bug in auth",
    failedQueueId: null,
    failedJobId: null,
    failureArtifact: null,
  },
});

const locator = await buildLocator(root, project, job.jobId);
assert.equal(locator.sourceContext.issueNumber, 63, "locator should have sourceContext.issueNumber");
assert.equal(locator.sourceContext.queueEntryId, "q-test-123");

const envelope = locatorEnvelope(locator);
assert.equal(envelope.sourceContext.issueNumber, 63, "envelope should expose sourceContext");
assert.equal(envelope.sourceContext.issueUrl, "https://github.com/example/repo/issues/63");
console.log("OK: locator and envelope expose source context");

// Job without source context
const plainJob = await createJob(root, {
  project,
  task: "plain task",
  ts: "2026-05-21T22:00:00.000Z",
});
const plainLocator = await buildLocator(root, project, plainJob.jobId);
assert.equal(plainLocator.sourceContext, null, "locator without sourceContext should be null");
const plainEnvelope = locatorEnvelope(plainLocator);
assert.equal(plainEnvelope.sourceContext, null, "envelope without sourceContext should be null");
console.log("OK: plain job has null sourceContext in locator and envelope");

console.log("\nAll phase-locator source context tests passed.");
