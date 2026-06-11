#!/usr/bin/env node
// @ts-nocheck
import path from "node:path";
import { listJobs } from "../../server/services/job-store.js";

const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
const jobs = await listJobs(cpbRoot);

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
