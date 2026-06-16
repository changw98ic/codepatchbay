/**
 * Handoff Bundle — generates continuation context for provider fallback.
 *
 * When a provider fails mid-run (quota exhaustion), the handoff bundle
 * gives the fallback agent enough context to continue without restarting.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFile = promisify(execFileCb);

// Max handoff bundle size (50KB) — prevents token overflow in continuation prompts
const MAX_BUNDLE_SIZE = 50_000;

/**
 * Redact secrets and strip control chars from text.
 * Mirrors server/services/provider-quota.js:redactSecrets — kept here
 * to avoid core/ → server/ import boundary violation.
 */
function redactSecrets(text: unknown) {
  if (!text) return "";
  return String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]")
    .replace(/api[_-]?key=\S+/gi, "api_key=[REDACTED]")
    .replace(/sk-\S+/gi, "sk-[REDACTED]")
    .replace(/OPENAI_API_KEY=\S+/gi, "OPENAI_API_KEY=[REDACTED]")
    .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/**
 * Generate a handoff bundle for mid-run provider fallback.
 *
 * @param {object} opts
 * @param {string} opts.project
 * @param {string} opts.jobId
 * @param {string} opts.phase
 * @param {string} opts.task - original task description
 * @param {string} opts.originProvider - provider that failed
 * @param {string} opts.failureReason
 * @param {string} [opts.partialStdout]
 * @param {string} [opts.partialStderr]
 * @param {Array}  [opts.previousResults] - results from prior phases
 * @param {string} opts.cpbRoot
 * @param {string} [opts.sourcePath]
 * @returns {Promise<string>} markdown handoff document
 */
export async function generateHandoffBundle({
  project,
  jobId,
  phase,
  task,
  originProvider,
  failureReason,
  partialStdout = "",
  partialStderr = "",
  previousResults = [],
  cpbRoot,
  sourcePath,
}) {
  const cwd = sourcePath || cpbRoot;
  const sections = [];

  sections.push(`# Handoff Bundle — ${project}/${jobId}`);
  sections.push(`\nGenerated: ${new Date().toISOString()}\n`);

  // Original task
  sections.push(`## Original Task\n`);
  sections.push(task || "(no task description)");
  sections.push("");

  // Plan artifact (from previous phases)
  const planResult = previousResults.find((r) => r.phase === "plan" || r.artifact);
  if (planResult?.artifact) {
    sections.push(`## Plan Artifact\n`);
    sections.push(`Artifact: ${planResult.artifact.name || planResult.artifact}`);
    sections.push("");
  }

  // Current phase
  sections.push(`## Current Phase\n`);
  sections.push(`Phase: **${phase}**`);
  sections.push(`Origin provider: **${originProvider}**`);
  sections.push(`Failure reason: ${redactSecrets(failureReason)}`);
  sections.push("");

  // Partial output (redacted)
  if (partialStdout) {
    sections.push(`## Partial Stdout (last 2000 chars)\n`);
    sections.push("```");
    sections.push(redactSecrets(partialStdout).slice(-2000));
    sections.push("```");
    sections.push("");
  }
  if (partialStderr) {
    sections.push(`## Partial Stderr (last 1000 chars)\n`);
    sections.push("```");
    sections.push(redactSecrets(partialStderr).slice(-1000));
    sections.push("```");
    sections.push("");
  }

  // Git state
  const gitState = await captureGitState(cwd);
  if (gitState) {
    sections.push(`## Git Status\n`);
    sections.push("```");
    sections.push(redactSecrets(gitState.status));
    sections.push("```");
    sections.push("");

    if (gitState.diff) {
      sections.push(`## Git Diff (staged + unstaged, last 3000 chars)\n`);
      sections.push("```diff");
      sections.push(redactSecrets(gitState.diff).slice(-3000));
      sections.push("```");
      sections.push("");
    }

    if (gitState.changedFiles.length > 0) {
      sections.push(`## Changed Files\n`);
      for (const f of gitState.changedFiles) {
        sections.push(`- ${f}`);
      }
      sections.push("");
    }
  }

  // Continuation instruction
  sections.push(`## Continuation Instruction\n`);
  sections.push("You are continuing an interrupted execution.");
  sections.push("First read the git diff and existing changes.");
  sections.push("Do not overwrite or restart from scratch.");
  sections.push("Preserve existing edits unless they are clearly wrong.");
  sections.push("Complete the remaining work and return the required JSON envelope.");
  sections.push("");

  let bundle = sections.join("\n");
  if (bundle.length > MAX_BUNDLE_SIZE) {
    bundle = bundle.slice(0, MAX_BUNDLE_SIZE) + "\n\n<!-- TRUNCATED: bundle exceeded 50KB limit -->\n";
  }
  return bundle;
}

async function captureGitState(cwd: string) {
  try {
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFile("git", ["status", "--porcelain"], { cwd, timeout: 5000 }),
      execFile("git", ["diff", "HEAD"], { cwd, timeout: 10000 }).catch(() => ({ stdout: "" })),
    ]);
    const changedFiles = status.trim().split("\n").filter(Boolean).map((line) => line.slice(3));
    return { status: status.trim(), diff: diff.trim(), changedFiles };
  } catch {
    return null;
  }
}
