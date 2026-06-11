import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  resolveReleaseStoreRoot,
  listReleases,
  readReleaseMetadata,
  inspectCurrentRelease,
} from "./release-store.js";
import { listJobs } from "./job-store.js";

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function collectReleasePins(jobs) {
  const pins = new Map();
  for (const job of jobs) {
    const ids = new Set();
    if (job.executor?.releaseId) ids.add(job.executor.releaseId);
    if (job.lineage?.executorSelection?.selectedReleaseId) ids.add(job.lineage.executorSelection.selectedReleaseId);
    if (job.lineage?.executorSelection?.parentReleaseId) ids.add(job.lineage.executorSelection.parentReleaseId);
    for (const id of ids) {
      if (!pins.has(id)) pins.set(id, []);
      pins.get(id).push({ jobId: job.jobId, status: job.status, project: job.project });
    }
  }
  return pins;
}

async function collectProcessAndLeaseEvidence(cpbRoot, jobs) {
  const processReleaseIds = new Set();
  const leaseReleaseIds = new Set();

  // Build a jobId -> job map for resolving lease/process references
  const jobMap = new Map();
  for (const job of jobs) {
    if (job.jobId) jobMap.set(job.jobId, job);
  }

  try {
    const { listProcesses } = await import("./process-registry.js");
    const processes = await listProcesses(cpbRoot);
    for (const proc of processes) {
      if (proc.status === "running") {
        // Resolve process -> jobId -> job -> executor.releaseId
        const job = jobMap.get(proc.jobId);
        if (job?.executor?.releaseId) processReleaseIds.add(job.executor.releaseId);
      }
    }
  } catch {}
  try {
    const { runtimeDataPath } = await import("./runtime-root.js");
    const leasesDir = runtimeDataPath(cpbRoot, "leases");
    const files = await readdir(leasesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(await readFile(path.join(leasesDir, f), "utf8"));
        // Resolve lease -> jobId -> job -> executor.releaseId (real lease schema)
        if (lease.jobId) {
          const job = jobMap.get(lease.jobId);
          if (job?.executor?.releaseId) leaseReleaseIds.add(job.executor.releaseId);
        }
      } catch {}
    }
  } catch {}
  return { processReleaseIds, leaseReleaseIds };
}

export async function buildReleaseGcPlan({ cpbRoot, env = process.env, destRoot }: Record<string, any> = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
  const releaseList = await listReleases({ destRoot, env });
  const currentReleaseId = releaseList.current;

  let jobs;
  try {
    jobs = await listJobs(resolvedCpbRoot);
  } catch (err) {
    throw new Error(`Cannot build release GC plan: failed to read job inventory: ${(err as Error).message}`);
  }

  const jobPins = collectReleasePins(jobs);
  const { processReleaseIds, leaseReleaseIds } = await collectProcessAndLeaseEvidence(resolvedCpbRoot, jobs);

  const candidates = [];

  for (const release of releaseList.releases) {
    const releaseId = release.releaseId;
    const installedPath = release.installedPath;
    const reasons = [];
    let classification = "eligible";

    if (releaseId === currentReleaseId) {
      reasons.push("current");
      classification = "protected";
    }

    if (release.status === "invalid") {
      reasons.push("missing_metadata");
      classification = "unsafe";
    }

    const resolvedInstalled = path.resolve(installedPath);
    if (!resolvedInstalled.startsWith(storeRoot + path.sep) && resolvedInstalled !== storeRoot) {
      reasons.push("outside_release_root");
      classification = "unsafe";
    }

    try {
      const info = await lstat(installedPath);
      if (info.isSymbolicLink()) {
        reasons.push("symlinked");
        classification = "unsafe";
      }
    } catch {
      reasons.push("missing");
      classification = "unsafe";
    }

    const jobPin = jobPins.get(releaseId);
    if (jobPin) {
      const activeJobs = jobPin.filter(j => !["completed", "failed", "blocked", "cancelled"].includes(j.status));
      if (activeJobs.length > 0) {
        reasons.push(`active_job:${activeJobs.length}`);
        classification = "protected";
      } else {
        reasons.push(`recent_job:${jobPin.length}`);
        classification = "protected";
      }
    }

    if (processReleaseIds.has(releaseId)) {
      reasons.push("process_alive");
      classification = "protected";
    }
    if (leaseReleaseIds.has(releaseId)) {
      reasons.push("lease_active");
      classification = "protected";
    }

    candidates.push({
      releaseId,
      installedPath,
      classification,
      reasons,
    });
  }

  // Surface unknown release references from jobs/processes/leases that are
  // NOT in the installed release list. These are unsafe by definition.
  const installedIds = new Set(releaseList.releases.map(r => r.releaseId));
  for (const [releaseId, jobs] of jobPins) {
    if (installedIds.has(releaseId)) continue;
    candidates.push({
      releaseId,
      installedPath: null,
      classification: "unsafe",
      reasons: ["unknown_reference", `${jobs.length}_job_pin(s)`],
    });
  }
  for (const releaseId of processReleaseIds) {
    if (installedIds.has(releaseId) || jobPins.has(releaseId)) continue;
    candidates.push({
      releaseId,
      installedPath: null,
      classification: "unsafe",
      reasons: ["unknown_reference", "process_alive"],
    });
  }
  for (const releaseId of leaseReleaseIds) {
    if (installedIds.has(releaseId) || jobPins.has(releaseId) || processReleaseIds.has(releaseId)) continue;
    candidates.push({
      releaseId,
      installedPath: null,
      classification: "unsafe",
      reasons: ["unknown_reference", "lease_active"],
    });
  }

  return {
    releaseStoreRoot: storeRoot,
    currentReleaseId,
    candidates,
    generatedAt: new Date().toISOString(),
  };
}

export async function executeReleaseGc(plan, { destRoot, env = process.env, cpbRoot }: Record<string, any> = {}) {
  const eligible = plan.candidates.filter(c => c.classification === "eligible");
  const protected_ = plan.candidates.filter(c => c.classification === "protected");
  const unsafe = plan.candidates.filter(c => c.classification === "unsafe");

  const deleted = [];
  const skipped = [];
  const refused = [];

  // Revalidate safety invariants at execution time to guard against
  // stale or misclassified plans.
  const currentSelection = await inspectCurrentRelease({ env });
  const currentReleaseId = currentSelection?.metadata?.releaseId || currentSelection?.selector?.releaseId || plan.currentReleaseId || null;

  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  let liveJobPins;
  try {
    const jobs = await listJobs(resolvedCpbRoot);
    liveJobPins = collectReleasePins(jobs);
  } catch (err) {
    // Fail-closed: refuse all deletions when job inventory is unreadable
    return {
      deleted: [],
      skipped: protected_.map(c => ({ ...c, skipReason: "protected" })),
      refused: [
        ...eligible.map(c => ({ ...c, refusalReason: `job_inventory_unreadable: ${(err as Error).message}` })),
        ...unsafe.map(c => ({ ...c, refusalReason: "unsafe" })),
      ],
      executedAt: new Date().toISOString(),
    };
  }

  for (const candidate of eligible) {
    // Re-check: current release must never be deleted
    if (currentReleaseId && candidate.releaseId === currentReleaseId) {
      refused.push({ ...candidate, refusalReason: "current_release_revalidated" });
      continue;
    }

    // Re-check: job-pinned releases must not be deleted
    if (liveJobPins.has(candidate.releaseId)) {
      refused.push({ ...candidate, refusalReason: "job_pinned_revalidated" });
      continue;
    }

    // Re-check: metadata must be readable and releaseId must match candidate
    let liveMetadata;
    try {
      liveMetadata = await readReleaseMetadata(candidate.installedPath);
    } catch {
      refused.push({ ...candidate, refusalReason: "metadata_invalid_revalidated" });
      continue;
    }
    if (liveMetadata.releaseId !== candidate.releaseId) {
      refused.push({ ...candidate, refusalReason: `manifest_release_id_mismatch: expected '${candidate.releaseId}' found '${liveMetadata.releaseId}'` });
      continue;
    }

    // Re-check: resolved path must not match current release path
    const currentReleasePath = (currentSelection as Record<string, any> | null | undefined)?.linkTarget || currentSelection?.selector?.releasePath;
    if (currentReleasePath && path.resolve(candidate.installedPath) === path.resolve(currentReleasePath)) {
      refused.push({ ...candidate, refusalReason: "path_matches_current_release_revalidated" });
      continue;
    }

    try {
      const storeRoot = resolveReleaseStoreRoot({ destRoot, env });
      const resolvedPath = path.resolve(candidate.installedPath);
      if (!resolvedPath.startsWith(storeRoot + path.sep) && resolvedPath !== storeRoot) {
        refused.push({ ...candidate, refusalReason: "path_escape_verified" });
        continue;
      }
      const info = await lstat(resolvedPath);
      if (info.isSymbolicLink()) {
        refused.push({ ...candidate, refusalReason: "symlink_verified" });
        continue;
      }
      await rm(resolvedPath, { recursive: true, force: true });
      deleted.push(candidate);
    } catch (err) {
      refused.push({ ...candidate, refusalReason: `delete_failed: ${err.message}` });
    }
  }

  for (const candidate of protected_) {
    skipped.push({ ...candidate, skipReason: "protected" });
  }
  for (const candidate of unsafe) {
    refused.push({ ...candidate, refusalReason: "unsafe" });
  }

  return {
    deleted,
    skipped,
    refused,
    executedAt: new Date().toISOString(),
  };
}

export function formatGcPlanHuman(plan) {
  const lines = [];
  lines.push("Release GC Plan:");
  lines.push(`  Store root: ${plan.releaseStoreRoot}`);
  lines.push(`  Current release: ${plan.currentReleaseId || "(none)"}`);
  lines.push("");

  for (const c of plan.candidates) {
    const marker = c.classification === "eligible" ? "E"
      : c.classification === "protected" ? "P"
      : "U";
    const color = c.classification === "eligible" ? "\x1b[0;32m"
      : c.classification === "protected" ? "\x1b[1;33m"
      : "\x1b[0;31m";
    const NC = "\x1b[0m";
    lines.push(`  ${color}${marker}${NC} ${c.releaseId}  ${c.reasons.join(", ") || "no issues"}`);
  }

  const counts = { eligible: 0, protected: 0, unsafe: 0 };
  for (const c of plan.candidates) counts[c.classification]++;
  lines.push("");
  lines.push(`  Eligible: ${counts.eligible}  Protected: ${counts.protected}  Unsafe: ${counts.unsafe}`);
  return lines.join("\n");
}

export function formatGcResultHuman(result) {
  const lines = [];
  lines.push("Release GC Result:");
  lines.push(`  Deleted: ${result.deleted.length}`);
  for (const d of result.deleted) lines.push(`    - ${d.releaseId}`);
  lines.push(`  Skipped (protected): ${result.skipped.length}`);
  for (const s of result.skipped) lines.push(`    - ${s.releaseId}: ${s.skipReason}`);
  lines.push(`  Refused (unsafe): ${result.refused.length}`);
  for (const r of result.refused) lines.push(`    - ${r.releaseId}: ${r.refusalReason}`);
  return lines.join("\n");
}
