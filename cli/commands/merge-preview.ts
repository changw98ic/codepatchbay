#!/usr/bin/env node
// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProject, resolveHubRoot } from "../../server/services/hub-registry.js";
import { previewMerge } from "../../server/services/merge-steward.js";

function usage() {
  return [
    "Usage: cpb merge-preview <project> <candidate-ref-or-worktree> [--base <ref>] [--json]",
    "",
    "Runs a conservative merge-steward preview in a temporary worktree.",
    "It never commits, never updates main, and rejects CPB/shared-state changes.",
  ].join("\n");
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    baseRef: "HEAD",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--base") {
      const value = argv[i + 1];
      if (!value) throw new Error("--base requires a value");
      options.baseRef = value;
      i += 1;
    } else if (arg.startsWith("--base=")) {
      options.baseRef = arg.slice("--base=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return {
    ...options,
    projectId: positional[0],
    candidate: positional[1],
    extra: positional.slice(2),
  };
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatHuman(result, projectId) {
  const lines = [
    `Merge preview: ${projectId}`,
    `Repository: ${result.repoRoot}`,
    `Base: ${result.baseRef} (${result.baseHead.slice(0, 12)})`,
    `Candidate: ${result.candidate.input} (${result.candidate.commit.slice(0, 12)}, ${result.candidate.source})`,
    `Merge status: ${result.mergeStatus}`,
    `Changed files: ${result.changedFiles.length} (${formatCounts(result.changedCounts)})`,
    `Conflict files: ${result.conflictFiles.length} (${formatCounts(result.conflictCounts)})`,
    `Safe for merge steward: ${result.safeForSteward ? "yes" : "no"}`,
  ];

  if (result.abortReasons.length > 0) {
    lines.push("");
    lines.push("Abort reasons:");
    for (const reason of result.abortReasons) {
      lines.push(`- ${reason.code}: ${reason.message}`);
      for (const file of reason.files.slice(0, 20)) lines.push(`  ${file}`);
      if (reason.files.length > 20) lines.push(`  ... ${reason.files.length - 20} more`);
    }
  }

  if (result.conflictFiles.length > 0) {
    lines.push("");
    lines.push("Conflict classification:");
    for (const entry of result.conflictFiles) {
      lines.push(`- ${entry.classification}: ${entry.file}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function run(args, context) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.projectId || !options.candidate || options.extra.length > 0) {
    throw new Error(usage());
  }

  const cpbRoot = context?.cpbRoot || path.resolve(process.env.CPB_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const hubRoot = resolveHubRoot(cpbRoot);
  const project = await getProject(hubRoot, options.projectId);
  if (!project?.sourcePath) {
    throw new Error(`project not found in Hub registry: ${options.projectId}`);
  }

  const result = await previewMerge({
    repoRoot: project.sourcePath,
    baseRef: options.baseRef,
    candidate: options.candidate,
  });

  if (options.json) {
    console.log(JSON.stringify({ projectId: options.projectId, ...result }, null, 2));
  } else {
    process.stdout.write(formatHuman(result, options.projectId));
  }

  if (!result.safeForSteward) return 2;
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
