#!/usr/bin/env node
import { buildArtifactsForJob, readArtifactContent } from "./artifacts.js";

function usage() {
  return "Usage: cpb verdict <job-id> [--json]";
}

function formatVerdictHuman(payload: Record<string, any>) {
  if (!payload.verdict) return `Verdict not found for ${payload.jobId}\n`;
  const lines = [
    `Verdict for ${payload.jobId}`,
    `Path: ${payload.verdict.path}`,
    `Status: ${payload.verdict.broken ? "BROKEN" : "OK"}`,
    "",
  ];
  if (payload.content) lines.push(payload.content.trimEnd());
  else if (payload.verdict.reason) lines.push(payload.verdict.reason);
  return `${lines.join("\n")}\n`;
}

export async function run(args: string[] = [], { cpbRoot }: { cpbRoot: string }) {
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

  const verdict = index.entries.find((entry) => entry.kind === "verdict") || null;
  const payload = {
    jobId,
    project: index.project,
    verdict,
    content: await readArtifactContent(verdict),
  };

  if (!verdict) {
    if (args.includes("--json")) console.log(JSON.stringify(payload, null, 2));
    else console.error(formatVerdictHuman(payload).trimEnd());
    return 1;
  }

  if (args.includes("--json")) console.log(JSON.stringify(payload, null, 2));
  else console.log(formatVerdictHuman(payload));
  return verdict.broken ? 1 : 0;
}
