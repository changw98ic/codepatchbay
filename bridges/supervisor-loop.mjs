#!/usr/bin/env node
import path from "node:path";
import { recoverJobs } from "../server/services/supervisor.js";

const flowRoot = path.resolve(process.env.FLOW_ROOT || path.join(import.meta.dirname, ".."));
const intervalMs = Number(process.env.FLOW_SUPERVISOR_INTERVAL_MS || 30_000);

async function tick() {
  const jobs = await recoverJobs(flowRoot);
  for (const job of jobs) {
    console.log(`${new Date().toISOString()} recoverable ${job.jobId} ${job.project} ${job.phase || "-"}`);
  }
}

await tick();
setInterval(tick, intervalMs);
