#!/usr/bin/env node
import path from "node:path";
import { resolveHubRoot } from "../../server/services/hub/hub-registry.js";
import { listJobsAcrossRuntimeRoots } from "../../server/services/job/job-store.js";

type ListedJob = {
  jobId: string;
  project?: string;
  status?: string;
  phase?: string;
  task?: string;
  lineage?: {
    parentJobId?: string;
    parentFailurePhase?: string;
    parentFailureCode?: string;
    parentStatus?: string;
  };
};

const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, {
  hubRoot: process.env.CPB_HUB_ROOT || resolveHubRoot(cpbRoot),
}) as ListedJob[];

for (const job of jobs) {
  let lineageTag = "-";
  if (job.lineage?.parentJobId) {
    const parts = [`recovery:${job.lineage.parentJobId}`];
    if (job.lineage.parentFailurePhase) parts.push(`at:${job.lineage.parentFailurePhase}`);
    if (job.lineage.parentFailureCode) parts.push(`code:${job.lineage.parentFailureCode}`);
    if (job.lineage.parentStatus) parts.push(job.lineage.parentStatus);
    lineageTag = parts.join(" ");
  }
  const childCount = jobs.filter((j) => j.lineage?.parentJobId === job.jobId).length;
  const childTag = childCount > 0 ? `children:${childCount}` : "";
  console.log(`${job.jobId}\t${job.project}\t${job.status}\t${job.phase || "-"}\t${lineageTag}\t${childTag}\t${job.task}`);
}
