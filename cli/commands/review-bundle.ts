#!/usr/bin/env node
import path from "node:path";

import { buildReviewBundle, writeReviewBundle } from "../../server/services/review/review-session.js";
import { findJobForCli } from "./artifacts.js";

function usage() {
  return [
    "Usage: cpb review-bundle <project> <job-id> [--json] [--out <dir>]",
    "",
    "Generate or display a local review bundle for a completed pipeline job.",
    "When GitHub transport is unavailable, bundles are the primary review artifact.",
  ].join("\n");
}

function parseArgs(argv) {
  const positional = [];
  const options = { json: false, out: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out requires a value");
      options.out = value;
      i += 1;
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { ...options, project: positional[0], jobId: positional[1] };
}

export async function run(args, context: Record<string, any> = {}) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.project || !options.jobId) {
    throw new Error(usage());
  }

  const cpbRoot = context?.cpbRoot || path.resolve(
    process.env.CPB_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".."),
  );

  const found = await findJobForCli(cpbRoot, options.jobId);
  if (found && found.job.project !== options.project) {
    throw new Error(`job ${options.jobId} belongs to project ${found.job.project}, not ${options.project}`);
  }

  const bundle = await buildReviewBundle(cpbRoot, options.project, options.jobId, found ? {
    dataRoot: found.dataRoot,
    wikiDir: found.wikiDir,
  } : {});

  if (options.out) {
    const filePath = await writeReviewBundle(options.out, bundle);
    if (!options.json) console.log(`Review bundle written to ${filePath}`);
  }

  if (options.json || !options.out) {
    console.log(JSON.stringify(bundle, null, 2));
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    });
}
