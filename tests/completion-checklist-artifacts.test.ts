import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { loadCompletionChecklistArtifacts } from "../core/engine/completion-checklist-artifacts.js";
import { tempRoot } from "./helpers.js";

async function writeJsonArtifact(root: string, name: string, content: Record<string, unknown>) {
  const artifactPath = path.join(root, `${name}.json`);
  await writeFile(artifactPath, `${JSON.stringify(content)}\n`, "utf8");
  return artifactPath;
}

test("loadCompletionChecklistArtifacts skips checklist gate for legacy jobs without checklist anchor", async () => {
  const result = await loadCompletionChecklistArtifacts({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-legacy",
    attemptId: "attempt-1",
    getArtifactIndex: async () => ({
      entries: [{
        kind: "verdict",
        exists: true,
        path: "/tmp/cpb/verdict.md",
        attemptId: "attempt-1",
      }],
    }),
  });

  assert.deepEqual(result, {
    checklistArtifacts: {},
    artifactInvalidReason: null,
  });
});

test("loadCompletionChecklistArtifacts loads active checklist artifacts when checklist anchor exists", async () => {
  const cpbRoot = await tempRoot("cpb-completion-checklist-artifacts");
  const artifactRoot = path.join(cpbRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });

  const artifacts = {
    "acceptance-checklist": { kind: "acceptance-checklist", items: [{ id: "AC-1" }] },
    "execution-map": { kind: "execution-map", changedFiles: ["core/engine/run-job.ts"] },
    "evidence-ledger": { kind: "evidence-ledger", evidence: [{ id: "EV-1" }] },
    "checklist-verdict": { kind: "checklist-verdict", status: "pass" },
  };
  const entries = [];
  for (const [kind, content] of Object.entries(artifacts)) {
    entries.push({
      kind,
      exists: true,
      path: await writeJsonArtifact(artifactRoot, kind, content),
      attemptId: "attempt-1",
      createdAt: "2026-06-22T00:00:00.000Z",
    });
  }

  const result = await loadCompletionChecklistArtifacts({
    cpbRoot,
    project: "proj",
    jobId: "job-checklist",
    attemptId: "attempt-1",
    getArtifactIndex: async () => ({ entries }),
  });

  assert.equal(result.artifactInvalidReason, null);
  assert.deepEqual(result.checklistArtifacts, {
    ok: true,
    ...artifacts,
  });
});

test("loadCompletionChecklistArtifacts fails closed when anchored checklist artifacts are incomplete", async () => {
  const cpbRoot = await tempRoot("cpb-completion-checklist-incomplete");
  const artifactRoot = path.join(cpbRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const checklistPath = await writeJsonArtifact(artifactRoot, "acceptance-checklist", {
    kind: "acceptance-checklist",
  });

  const result = await loadCompletionChecklistArtifacts({
    cpbRoot,
    project: "proj",
    jobId: "job-incomplete",
    attemptId: "attempt-1",
    getArtifactIndex: async () => ({
      entries: [{
        kind: "acceptance-checklist",
        exists: true,
        path: checklistPath,
        attemptId: "attempt-1",
      }],
    }),
  });

  assert.equal(result.checklistArtifacts.ok, false);
  assert.match(String(result.artifactInvalidReason), /artifact execution-map has no entry matching attemptId=attempt-1/);
});

test("loadCompletionChecklistArtifacts reports artifact index read failures as artifact-invalid reasons", async () => {
  const result = await loadCompletionChecklistArtifacts({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-index-failure",
    attemptId: "attempt-1",
    getArtifactIndex: async () => {
      throw new Error("index unavailable");
    },
  });

  assert.deepEqual(result, {
    checklistArtifacts: {},
    artifactInvalidReason: "artifact index read failed: index unavailable",
  });
});
