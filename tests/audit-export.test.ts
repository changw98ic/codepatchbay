import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildJobAuditExport } from "../server/services/audit-export.js";
import { appendEvent } from "../server/services/event-store.js";
import { tempRoot } from "./helpers.js";

test("audit export marks absolute artifact references broken without hashing host paths", async () => {
  const cpbRoot = await tempRoot("cpb-audit-absolute");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const outside = path.join(await tempRoot("cpb-audit-outside"), "verdict-secret.md");
  await writeFile(outside, "VERDICT: PASS\nsecret-ish host file\n", "utf8");
  await appendEvent(cpbRoot, "proj", "job-audit-absolute", {
    type: "phase_completed",
    jobId: "job-audit-absolute",
    project: "proj",
    phase: "verify",
    artifact: outside,
    ts: "2026-06-04T10:00:00.000Z",
  }, { dataRoot });

  const audit = await buildJobAuditExport(cpbRoot, "proj", "job-audit-absolute", { dataRoot });
  assert.equal(audit.verdict, null);
  assert.equal(audit.artifactIndex.entries.length, 1);
  const entry = audit.artifactIndex.entries[0];
  assert.equal(entry.broken, true);
  assert.equal(entry.sha256, null);
  assert.equal(entry.path, "verdict-secret.md");
  assert.match(entry.reason, /outside project wiki/);
});

test("audit export blocks traversal artifact references outside wiki roots", async () => {
  const cpbRoot = await tempRoot("cpb-audit-traversal");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  await mkdir(path.join(dataRoot, "wiki", "outputs"), { recursive: true });
  await appendEvent(cpbRoot, "proj", "job-audit-traversal", {
    type: "phase_completed",
    jobId: "job-audit-traversal",
    project: "proj",
    phase: "execute",
    artifact: "../outside.md",
    ts: "2026-06-04T10:00:00.000Z",
  }, { dataRoot });

  const audit = await buildJobAuditExport(cpbRoot, "proj", "job-audit-traversal", { dataRoot });
  const entry = audit.artifactIndex.entries[0];
  assert.equal(entry.broken, true);
  assert.equal(entry.sha256, null);
  assert.equal(entry.path, "outside.md");
  assert.match(entry.reason, /outside project wiki/);
});

test("audit export still parses verdict artifacts inside the project wiki", async () => {
  const cpbRoot = await tempRoot("cpb-audit-inside");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "proj");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });
  await writeFile(path.join(outputs, "verdict-ok.md"), "VERDICT: PASS\nAll good.\n", "utf8");
  await appendEvent(cpbRoot, "proj", "job-audit-inside", {
    type: "phase_completed",
    jobId: "job-audit-inside",
    project: "proj",
    phase: "verify",
    artifact: "verdict-ok.md",
    ts: "2026-06-04T10:00:00.000Z",
  }, { dataRoot });

  const audit = await buildJobAuditExport(cpbRoot, "proj", "job-audit-inside", { dataRoot });
  assert.equal(audit.artifactIndex.entries[0].broken, false);
  assert.equal(audit.verdict.status, "pass");
});
