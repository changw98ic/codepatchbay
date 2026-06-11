import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildArtifactIndex } from "../server/services/artifact-index.js";
import { buildJobArtifactDetail } from "../server/services/job-artifact-detail.js";
import { tempRoot } from "./helpers.js";

async function writeEvents(dataRoot, project, jobId, events) {
  const dir = path.join(dataRoot, "events", project);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${jobId}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

async function writeArtifact(dataRoot, kind, fileName, content) {
  const folder = kind === "plan" ? "inbox" : "outputs";
  const dir = path.join(dataRoot, "wiki", folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, "utf8");
}

async function assertMissing(file) {
  await assert.rejects(() => access(file), { code: "ENOENT" });
}

test("job artifact detail returns index warnings and null verdict when verdict is absent", async () => {
  const cpbRoot = await tempRoot("cpb-job-artifacts");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const project = "proj";
  const jobId = "job-artifacts-001";
  await writeEvents(dataRoot, project, jobId, [
    { type: "phase_completed", phase: "plan", artifact: "plan-missing.md", ts: "2026-06-04T10:00:00Z" },
    { type: "phase_completed", phase: "execute", artifact: "deliverable-missing.md", ts: "2026-06-04T10:01:00Z" },
  ]);

  const detail = await buildJobArtifactDetail(cpbRoot, project, jobId, { dataRoot });
  assert.equal(detail.project, project);
  assert.equal(detail.jobId, jobId);
  assert.equal(detail.verdict, null);
  assert.equal(detail.artifactIndex.entries.length, 2);
  assert.equal(detail.warnings.length, 2);
  await assertMissing(path.join(cpbRoot, "cpb-task"));
});

test("job artifact detail parses pass and fail verdict artifacts", async () => {
  const cpbRoot = await tempRoot("cpb-job-verdict");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const project = "proj";
  await writeArtifact(dataRoot, "outputs", "verdict-pass.md", "VERDICT: PASS\nAll checks passed.\n");
  await writeEvents(dataRoot, project, "job-pass", [
    { type: "phase_completed", phase: "verify", artifact: "verdict-pass.md", ts: "2026-06-04T10:00:00Z" },
  ]);
  const pass = await buildJobArtifactDetail(cpbRoot, project, "job-pass", { dataRoot });
  assert.equal(pass.verdict.status, "pass");

  await writeArtifact(dataRoot, "outputs", "verdict-fail.md", "VERDICT: FAIL\nTwo blocking issues found.\n");
  await writeEvents(dataRoot, project, "job-fail", [
    { type: "phase_completed", phase: "verify", artifact: "verdict-fail.md", ts: "2026-06-04T10:01:00Z" },
  ]);
  const fail = await buildJobArtifactDetail(cpbRoot, project, "job-fail", { dataRoot });
  assert.equal(fail.verdict.status, "fail");
  assert.ok(fail.verdict.reason);
  await assertMissing(path.join(cpbRoot, "cpb-task"));
});

test("buildArtifactIndex marks existing and missing artifacts consistently", async () => {
  const cpbRoot = await tempRoot("cpb-job-artifact-index");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const project = "proj";
  await writeArtifact(dataRoot, "plan", "plan-ok.md", "# Plan\n");
  const index = await buildArtifactIndex(cpbRoot, project, "job-index", {
    dataRoot,
    events: [
      { type: "phase_completed", phase: "plan", artifact: "plan-ok.md" },
      { type: "phase_completed", phase: "execute", artifact: "deliverable-gone.md" },
    ],
  });
  assert.equal(index.entries.find((entry) => entry.kind === "plan")?.broken, false);
  assert.equal(index.entries.find((entry) => entry.kind === "deliverable")?.broken, true);
  await assertMissing(path.join(cpbRoot, "cpb-task"));
});
