#!/usr/bin/env node
/**
 * CLI command for cancel/redirect operations.
 * Routed as: cpb cancel <project> <jobId> [reason]
 *            cpb redirect <project> <jobId> "<instructions>" [reason]
 */
import { requestCancelJob, requestRedirectJob } from "../../server/services/job-store.js";

function printUsage(command) {
  if (command === "redirect") {
    console.log("Usage: cpb redirect <project> <jobId> \"<instructions>\" [reason]");
  } else {
    console.log("Usage: cpb cancel <project> <jobId> [reason]");
  }
}

export async function run(args, context) {
  const command = context?.command;
  const cpbRoot = context?.cpbRoot || process.env.CPB_ROOT;

  if (!cpbRoot) {
    console.error("CPB_ROOT env var required");
    return 1;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printUsage(command);
    return 0;
  }

  if (command === "cancel") {
    const [project, jobId, ...reasonParts] = args;
    if (!project || !jobId) {
      printUsage("cancel");
      return 1;
    }
    const job = await requestCancelJob(cpbRoot, project, jobId, {
      reason: reasonParts.join(" ") || undefined,
    });
    console.log(JSON.stringify(job, null, 2));
  } else if (command === "redirect") {
    const [project, jobId, instructions, ...reasonParts] = args;
    if (!project || !jobId || !instructions) {
      printUsage("redirect");
      return 1;
    }
    const job = await requestRedirectJob(cpbRoot, project, jobId, {
      instructions,
      reason: reasonParts.join(" ") || undefined,
    });
    console.log(JSON.stringify(job, null, 2));
  } else {
    console.error(`Unknown action. Use cpb cancel or cpb redirect.`);
    return 1;
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cpbRoot = process.env.CPB_ROOT;
  if (!cpbRoot) {
    console.error("CPB_ROOT env var required");
    process.exit(1);
  }
  const [action, ...rest] = process.argv.slice(2);
  const command = action === "cancel" || action === "redirect" ? action : null;
  const args = command ? rest : process.argv.slice(2);
  run(args, { cpbRoot, command: command || action })
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
