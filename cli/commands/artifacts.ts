#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return "Usage: cpb artifacts <job-id> [--json]";
}

function legacyWikiDir(cpbRoot, project) {
  return path.join(path.resolve(cpbRoot), "wiki", "projects", project);
}

function runtimeWikiDir(dataRoot) {
  return path.join(path.resolve(dataRoot), "wiki");
}

export async function findJobForCli(cpbRoot, jobId) {
  const { listRuntimeDataRoots } = await import("../../server/services/runtime.js");
  const { listJobs } = await import("../../server/services/job/job-store.js");
  const roots = await listRuntimeDataRoots(cpbRoot, { hubRoot: process.env.CPB_HUB_ROOT });

  for (const root of roots) {
    const dataRoot = root.kind === "legacy" ? undefined : root.dataRoot;
    const jobs = await listJobs(cpbRoot, { dataRoot });
    const job = jobs.find((entry) => entry.jobId === jobId);
    if (!job) continue;
    return {
      job,
      dataRoot,
      rootKind: root.kind,
      wikiDir: root.kind === "legacy" ? legacyWikiDir(cpbRoot, job.project) : runtimeWikiDir(root.dataRoot),
    };
  }
  return null;
}

export function formatArtifactsHuman(index) {
  const lines = [`Artifacts for ${index.jobId}`, ""];
  if (index.entries.length === 0) {
    lines.push("No artifacts recorded.");
    return `${lines.join("\n")}\n`;
  }
  for (const entry of index.entries) {
    const status = entry.broken ? "BROKEN" : "OK";
    lines.push(`${status} ${entry.kind} ${entry.path}`);
    lines.push(`  phase: ${entry.phase || "-"} producer: ${entry.producerAgent || "-"}`);
    if (entry.reason) lines.push(`  reason: ${entry.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function buildArtifactsForJob(cpbRoot, jobId) {
  const found = await findJobForCli(cpbRoot, jobId);
  if (!found) return null;
  const { buildArtifactIndex } = await import("../../server/services/job/job-projection.js");
  const index = await buildArtifactIndex(cpbRoot, found.job.project, jobId, {
    dataRoot: found.dataRoot,
    wikiDir: found.wikiDir,
  });
  return {
    ...index,
    rootKind: found.rootKind,
    wikiDir: found.wikiDir,
  };
}

export async function readArtifactContent(entry) {
  if (!entry || entry.broken) return null;
  return readFile(entry.path, "utf8");
}

export async function run(args = [], { cpbRoot }) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const jobId = args.find((arg) => !arg.startsWith("--"));
  if (!jobId) {
    console.error(usage());
    return 1;
  }

  const index = await buildArtifactsForJob(cpbRoot, jobId);
  if (!index) {
    console.error(`Job not found: ${jobId}`);
    return 1;
  }

  if (args.includes("--json")) console.log(JSON.stringify(index, null, 2));
  else console.log(formatArtifactsHuman(index));
  return 0;
}
