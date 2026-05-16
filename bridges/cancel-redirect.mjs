#!/usr/bin/env node
/**
 * CLI helper for cancel/redirect operations.
 * Usage:
 *   node cancel-redirect.mjs cancel <project> <jobId> [reason]
 *   node cancel-redirect.mjs redirect <project> <jobId> <instructions> [reason]
 */
import { requestCancelJob, requestRedirectJob } from "../server/services/job-store.js";

const [,, action, project, jobId, arg3, ...rest] = process.argv;
const cpbRoot = process.env.CPB_ROOT;

if (!cpbRoot) {
  console.error("CPB_ROOT env var required");
  process.exit(1);
}

try {
  let job;
  if (action === "cancel") {
    job = await requestCancelJob(cpbRoot, project, jobId, { reason: arg3 || undefined });
  } else if (action === "redirect") {
    if (!arg3) {
      console.error("Usage: cpb redirect <project> <jobId> \"<instructions>\" [reason]");
      process.exit(1);
    }
    const reason = rest.join(" ") || undefined;
    job = await requestRedirectJob(cpbRoot, project, jobId, { instructions: arg3, reason });
  } else {
    console.error(`Unknown action: ${action}. Use cancel or redirect.`);
    process.exit(1);
  }
  console.log(JSON.stringify(job, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
