#!/usr/bin/env node
import path from "node:path";
import { listJobs } from "../server/services/job-store.js";

const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
const jobs = await listJobs(cpbRoot);

for (const job of jobs) {
  console.log(`${job.jobId}\t${job.project}\t${job.status}\t${job.phase || "-"}\t${job.task}`);
}
