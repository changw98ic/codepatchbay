import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  buildReleaseGcPlan,
  executeReleaseGc,
  formatGcPlanHuman,
  formatGcResultHuman,
} from "../server/services/release-gc.js";
import { installRelease, selectRelease } from "../server/services/release-store.js";

let tmpDir;
let cpbRoot;
let env;

async function makeMinimalSource(root) {
  await fs.mkdir(path.join(root, "bridges"), { recursive: true });
  await fs.writeFile(path.join(root, "bridges", "common.sh"), "# common.sh\n");
  await fs.writeFile(path.join(root, "bridges", "run-pipeline.mjs"), "// pipeline\n");
  await fs.writeFile(path.join(root, "bridges", "project-worker.mjs"), "// worker\n");
  await fs.writeFile(path.join(root, "bridges", "job-runner.mjs"), "// runner\n");
  await fs.mkdir(path.join(root, "server", "services"), { recursive: true });
  await fs.writeFile(path.join(root, "server", "services", "job-store.js"), "// js\n");
  await fs.writeFile(path.join(root, "cpb"), "#!/bin/bash\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "cpb-test", version: "0.0.1" }));
  // Required by installRelease ALLOWED_ASSETS
  await fs.mkdir(path.join(root, "profiles"), { recursive: true });
  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  // Required by installRelease wiki copy
  await fs.mkdir(path.join(root, "wiki", "system"), { recursive: true });
  await fs.mkdir(path.join(root, "wiki", "projects"), { recursive: true });
}

async function installFakeRelease(sourceRoot, storeRoot, name) {
  return installRelease({
    sourceRoot,
    destRoot: storeRoot,
    name,
    env,
    now: new Date(),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "cpb-release-gc-test-"));
  cpbRoot = path.join(tmpDir, "cpb");
  const storeRoot = path.join(tmpDir, "releases");
  await fs.mkdir(cpbRoot, { recursive: true });
  await fs.mkdir(storeRoot, { recursive: true });
  env = {
    HOME: tmpDir,
    CPB_HOME: tmpDir,
    CPB_ROOT: cpbRoot,
  };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("buildReleaseGcPlan classifies current release as protected", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  const current = plan.candidates.find(c => c.releaseId === "rel-current");
  assert.ok(current);
  assert.equal(current.classification, "protected");
  assert.ok(current.reasons.includes("current"));
});

test("buildReleaseGcPlan classifies unreferenced non-current release as eligible", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-old");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  const old = plan.candidates.find(c => c.releaseId === "rel-old");
  assert.ok(old);
  assert.equal(old.classification, "eligible");
});

test("buildReleaseGcPlan classifies release with job pin as protected", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-pinned");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Create a job that references rel-pinned
  const { createJob } = await import("../server/services/job-store.js");
  await createJob(cpbRoot, {
    project: "test-project",
    task: "test",
    executor: { releaseId: "rel-pinned", root: "/tmp" },
  });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  const pinned = plan.candidates.find(c => c.releaseId === "rel-pinned");
  assert.ok(pinned);
  assert.equal(pinned.classification, "protected");
  assert.ok(pinned.reasons.some(r => r.startsWith("active_job") || r.startsWith("recent_job")));
});

test("buildReleaseGcPlan surfaces unknown release references from jobs as unsafe", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-old");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Create a job that references a release not in the installed list
  const { createJob } = await import("../server/services/job-store.js");
  await createJob(cpbRoot, {
    project: "test-project",
    task: "test",
    executor: { releaseId: "rel-missing", root: "/tmp" },
  });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  const unknown = plan.candidates.find(c => c.releaseId === "rel-missing");
  assert.ok(unknown, "unknown release reference should appear in candidates");
  assert.equal(unknown.classification, "unsafe");
  assert.ok(unknown.reasons.includes("unknown_reference"));
  assert.ok(unknown.installedPath === null);
});

test("executeReleaseGc refuses job-pinned release revalidated at execution time", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-pinned");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Build a stale plan where rel-pinned is marked eligible (but a live job pins it)
  const { createJob } = await import("../server/services/job-store.js");
  await createJob(cpbRoot, {
    project: "test-project",
    task: "test",
    executor: { releaseId: "rel-pinned", root: "/tmp" },
  });

  const stalePlan = {
    releaseStoreRoot: storeRoot,
    currentReleaseId: "rel-current",
    candidates: [{
      releaseId: "rel-pinned",
      installedPath: path.join(storeRoot, "rel-pinned"),
      classification: "eligible",
      reasons: [],
    }],
    generatedAt: new Date().toISOString(),
  };

  const result = await executeReleaseGc(stalePlan, { destRoot: storeRoot, env, cpbRoot });

  assert.equal(result.deleted.length, 0);
  const refusedPinned = result.refused.find(r => r.releaseId === "rel-pinned" && r.refusalReason === "job_pinned_revalidated");
  assert.ok(refusedPinned, "job-pinned release should be refused with revalidation reason");
  // Directory still exists
  await fs.stat(path.join(storeRoot, "rel-pinned"));
});

test("dry-run does not delete anything", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-old");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  // Verify rel-old dir exists before
  const oldPath = path.join(storeRoot, "rel-old");
  await fs.stat(oldPath);

  // Dry-run is the default: build plan but don't execute
  const eligible = plan.candidates.filter(c => c.classification === "eligible");
  assert.ok(eligible.length > 0);

  // Dir still exists (we only built the plan, never called executeReleaseGc)
  await fs.stat(oldPath);
});

test("executeReleaseGc deletes only eligible releases", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-old");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });
  const result = await executeReleaseGc(plan, { destRoot: storeRoot, env });

  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0].releaseId, "rel-old");
  assert.ok(result.skipped.some(s => s.releaseId === "rel-current"));

  // rel-old directory gone
  await assert.rejects(fs.stat(path.join(storeRoot, "rel-old")));
  // rel-current directory still exists
  await fs.stat(path.join(storeRoot, "rel-current"));
});

test("executeReleaseGc refuses to delete current release even if misclassified in stale plan", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Build a stale plan that incorrectly classifies the current release as eligible
  const stalePlan = {
    releaseStoreRoot: storeRoot,
    currentReleaseId: "rel-current",
    candidates: [{
      releaseId: "rel-current",
      installedPath: path.join(storeRoot, "rel-current"),
      classification: "eligible",
      reasons: [],
    }],
    generatedAt: new Date().toISOString(),
  };

  const result = await executeReleaseGc(stalePlan, { destRoot: storeRoot, env, cpbRoot });

  assert.equal(result.deleted.length, 0);
  const refusedCurrent = result.refused.find(r => r.releaseId === "rel-current" && r.refusalReason === "current_release_revalidated");
  assert.ok(refusedCurrent, "current release should be refused with revalidation reason");
  // Still exists
  await fs.stat(path.join(storeRoot, "rel-current"));
});

test("formatGcPlanHuman produces output with plan summary", async () => {
  const plan = {
    releaseStoreRoot: "/tmp/releases",
    currentReleaseId: "rel-1",
    candidates: [
      { releaseId: "rel-1", classification: "protected", reasons: ["current"] },
      { releaseId: "rel-2", classification: "eligible", reasons: [] },
    ],
  };
  const output = formatGcPlanHuman(plan);
  assert.ok(output.includes("rel-1"));
  assert.ok(output.includes("rel-2"));
  assert.ok(output.includes("Eligible: 1"));
  assert.ok(output.includes("Protected: 1"));
});

test("formatGcResultHuman produces output with deleted/skipped/refused", () => {
  const result = {
    deleted: [{ releaseId: "old", installedPath: "/tmp/old", classification: "eligible", reasons: [] }],
    skipped: [],
    refused: [],
  };
  const output = formatGcResultHuman(result);
  assert.ok(output.includes("Deleted: 1"));
  assert.ok(output.includes("old"));
});

test("executeReleaseGc refuses tampered candidate whose installedPath points to current release", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-old");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Build a stale plan where rel-old is eligible but its installedPath points to rel-current
  const tamperedPlan = {
    releaseStoreRoot: storeRoot,
    currentReleaseId: "rel-current",
    candidates: [{
      releaseId: "rel-old",
      installedPath: path.join(storeRoot, "rel-current"), // tampered: points to current
      classification: "eligible",
      reasons: [],
    }],
    generatedAt: new Date().toISOString(),
  };

  const result = await executeReleaseGc(tamperedPlan, { destRoot: storeRoot, env, cpbRoot });

  assert.equal(result.deleted.length, 0, "tampered candidate must not be deleted");
  const refused = result.refused.find(r => r.releaseId === "rel-old");
  assert.ok(refused, "tampered candidate must appear in refused");
  assert.ok(
    refused.refusalReason.includes("manifest_release_id_mismatch") ||
    refused.refusalReason.includes("path_matches_current_release"),
    `refusal reason should indicate identity mismatch, got: ${refused.refusalReason}`,
  );
  // Current release directory still exists
  await fs.stat(path.join(storeRoot, "rel-current"));
  // rel-old also still exists (was not the target path)
  await fs.stat(path.join(storeRoot, "rel-old"));
});

test("executeReleaseGc refuses eligible candidate when manifest releaseId differs from candidate", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-other");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Build a stale plan claiming rel-other is eligible but with a mismatched releaseId
  const mismatchedPlan = {
    releaseStoreRoot: storeRoot,
    currentReleaseId: "rel-current",
    candidates: [{
      releaseId: "rel-fake",
      installedPath: path.join(storeRoot, "rel-other"), // manifest says rel-other, not rel-fake
      classification: "eligible",
      reasons: [],
    }],
    generatedAt: new Date().toISOString(),
  };

  const result = await executeReleaseGc(mismatchedPlan, { destRoot: storeRoot, env, cpbRoot });

  assert.equal(result.deleted.length, 0);
  const refused = result.refused.find(r => r.releaseId === "rel-fake");
  assert.ok(refused);
  assert.ok(refused.refusalReason.includes("manifest_release_id_mismatch"));
  // rel-other still exists
  await fs.stat(path.join(storeRoot, "rel-other"));
});

test("buildReleaseGcPlan throws when job inventory cannot be read", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Create a corrupt event file that causes readEvents to throw.
  // A malformed JSON line in the middle triggers _parseEventFile to throw,
  // which propagates through rebuildJobsIndex -> listJobs.
  const { runtimeDataRoot } = await import("../server/services/runtime-root.js");
  const eventsDir = path.join(runtimeDataRoot(cpbRoot), "events", "corrupt-project");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(
    path.join(eventsDir, "job-badc0de.jsonl"),
    '{"type":"job_created","jobId":"job-badc0de","project":"corrupt-project","task":"t","ts":"2024-01-01T00:00:00Z"}\n' +
    '{NOT VALID JSON}\n' +
    '{"type":"phase_started","jobId":"job-badc0de","project":"corrupt-project","phase":"p","ts":"2024-01-01T00:00:01Z"}\n',
    "utf8",
  );

  await assert.rejects(
    () => buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot }),
    (err) => err.message.includes("Cannot build release GC plan") && err.message.includes("job inventory"),
  );
});

test("executeReleaseGc refuses all deletions when job inventory unreadable at execution time", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-old");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Build a valid plan first (this creates the jobs index)
  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  // Now corrupt events and delete the index so listJobs will try to rebuild and fail
  const { runtimeDataRoot } = await import("../server/services/runtime-root.js");
  const rtRoot = runtimeDataRoot(cpbRoot);
  const eventsDir = path.join(rtRoot, "events", "corrupt-project");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(
    path.join(eventsDir, "job-badc0de.jsonl"),
    '{"type":"job_created","jobId":"job-badc0de","project":"corrupt-project","task":"t","ts":"2024-01-01T00:00:00Z"}\n' +
    '{NOT VALID JSON}\n' +
    '{"type":"phase_started","jobId":"job-badc0de","project":"corrupt-project","phase":"p","ts":"2024-01-01T00:00:01Z"}\n',
    "utf8",
  );
  // Delete the jobs index to force rebuildJobsIndex to run
  await fs.rm(path.join(rtRoot, "jobs-index.json"), { force: true });

  const result = await executeReleaseGc(plan, { destRoot: storeRoot, env, cpbRoot });

  assert.equal(result.deleted.length, 0, "must not delete when job inventory is unreadable");
  assert.ok(result.refused.length > 0);
  const inventoryRefused = result.refused.find(r => r.refusalReason.includes("job_inventory_unreadable"));
  assert.ok(inventoryRefused, "should have a refusal with job_inventory_unreadable reason");
  // Both releases still exist
  await fs.stat(path.join(storeRoot, "rel-current"));
  await fs.stat(path.join(storeRoot, "rel-old"));
});

test("lease evidence resolves via lease.jobId -> job executor releaseId", async () => {
  const sourceRoot = path.join(tmpDir, "source");
  await makeMinimalSource(sourceRoot);
  const storeRoot = path.join(tmpDir, "releases");
  await installFakeRelease(sourceRoot, storeRoot, "rel-current");
  await installFakeRelease(sourceRoot, storeRoot, "rel-leased");
  await selectRelease({ releaseId: "rel-current", destRoot: storeRoot, env });

  // Create a job that references rel-leased
  const { createJob } = await import("../server/services/job-store.js");
  const job = await createJob(cpbRoot, {
    project: "test-project",
    task: "test",
    executor: { releaseId: "rel-leased", root: "/tmp" },
  });

  // Create a lease pointing to that job (real lease schema: jobId, no releaseId)
  const { acquireLease } = await import("../server/services/lease-manager.js");
  await acquireLease(cpbRoot, {
    leaseId: "lease-test-1",
    jobId: job.jobId,
    phase: "execute",
    ttlMs: 30000,
  });

  const plan = await buildReleaseGcPlan({ cpbRoot, env, destRoot: storeRoot });

  const leased = plan.candidates.find(c => c.releaseId === "rel-leased");
  assert.ok(leased, "rel-leased should appear in candidates");
  assert.equal(leased.classification, "protected");
  assert.ok(leased.reasons.includes("lease_active"), `should have lease_active reason, got: ${leased.reasons.join(", ")}`);
});
