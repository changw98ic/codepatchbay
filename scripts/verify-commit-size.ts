#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// CI commit-size + message gate.
//
// A commit that exceeds the churn OR file-count threshold MUST carry an
// explanatory body (>= MIN_BODY_CHARS, ignoring git trailers). The motivating
// case is a 171k-line commit with a one-line message: unreviewable. The gate
// forces either decomposition or an explanation rather than silently letting a
// checkpoint blob through review.
//
// Merge commits are skipped (their numstat double-counts parents). Only HEAD is
// inspected, so the gate is shallow-clone safe (actions/checkout fetch-depth:1
// guarantees HEAD but not HEAD~1).

export type NumstatRow = { insertions: number; deletions: number; path: string };

export const DEFAULT_MAX_LINES = 1000;
export const DEFAULT_MAX_FILES = 30;
export const DEFAULT_MIN_BODY_CHARS = 40;

const DEFAULT_EXCLUDE_PREFIXES = ["dist/", "dist-tests/", "node_modules/"];

// Keep this allowlist deliberately narrow. A generic `word: value` matcher would
// mistake ordinary body prose such as "Note: ..." or "Step 1: ..." for a trailer.
const TRAILER_RE = /^(?:Signed-off-by|Co-Authored-By|Generated-with|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Cc|Fixes|Refs|Closes|Resolves|Change-Id|Reviewed-on):\s+/i;

export function parseNumstat(
  output: string,
  exclude: string[] = DEFAULT_EXCLUDE_PREFIXES,
): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const added = cols[0];
    const deleted = cols[1];
    const filePath = cols.slice(2).join("\t").replace(/\\/g, "/").trim();
    if (filePath.length === 0) continue;
    // binary files show "-\t-\t<path>" — skip them entirely.
    if (added === "-" || deleted === "-") continue;
    if (exclude.some((prefix) => filePath.startsWith(prefix))) continue;
    const insertions = Number.parseInt(added, 10);
    const deletions = Number.parseInt(deleted, 10);
    if (Number.isNaN(insertions) || Number.isNaN(deletions)) continue;
    rows.push({ insertions, deletions, path: filePath });
  }
  return rows;
}

export function sumChurn(rows: NumstatRow[]): { churn: number; files: number } {
  let churn = 0;
  for (const row of rows) churn += row.insertions + row.deletions;
  return { churn, files: rows.length };
}

// Explanatory body: everything after the subject line, with blank separators
// and git trailers removed. Returns "" when there is no qualifying body.
export function extractBody(message: string): string {
  const lines = message.replace(/\r/g, "").split("\n");
  let i = 1; // skip the subject
  while (i < lines.length && lines[i].trim() === "") i += 1;
  return lines
    .slice(i)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !TRAILER_RE.test(line))
    .join("\n")
    .trim();
}

export type CommitSizeInput = {
  churn: number;
  files: number;
  isMerge: boolean;
  message: string;
};

export type CommitSizeResult = {
  ok: boolean;
  churn: number;
  files: number;
  overridden: boolean;
  reasons: string[];
};

export function evaluateCommitSize(
  input: CommitSizeInput,
  opts: {
    maxLines?: number;
    maxFiles?: number;
    minBodyChars?: number;
    override?: string;
  } = {},
): CommitSizeResult {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const minBodyChars = opts.minBodyChars ?? DEFAULT_MIN_BODY_CHARS;

  const override = (opts.override ?? "").trim();
  if (override.length > 0) {
    return { ok: true, churn: input.churn, files: input.files, overridden: true, reasons: [] };
  }
  if (input.isMerge) {
    return { ok: true, churn: input.churn, files: input.files, overridden: false, reasons: [] };
  }

  const reasons: string[] = [];
  if (input.churn > maxLines) reasons.push(`${input.churn} changed lines > limit ${maxLines}`);
  if (input.files > maxFiles) reasons.push(`${input.files} files > limit ${maxFiles}`);

  if (reasons.length === 0) {
    return { ok: true, churn: input.churn, files: input.files, overridden: false, reasons: [] };
  }

  const body = extractBody(input.message);
  if (body.length >= minBodyChars) {
    return { ok: true, churn: input.churn, files: input.files, overridden: false, reasons };
  }

  reasons.push(`no explanatory body (>= ${minBodyChars} chars after subject, excluding trailers)`);
  return { ok: false, churn: input.churn, files: input.files, overridden: false, reasons };
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function main() {
  const numstat = gitOutput(["show", "--numstat", "--format=", "HEAD"]);
  const { churn, files } = sumChurn(parseNumstat(numstat));
  const message = gitOutput(["log", "-1", "--format=%B", "HEAD"]);
  const subject = message.split("\n", 1)[0] ?? "";
  const isMerge = /^Merge(\s|$)/.test(subject.trim());

  const result = evaluateCommitSize(
    { churn, files, isMerge, message },
    {
      maxLines: envInt("CPB_COMMIT_SIZE_MAX_LINES"),
      maxFiles: envInt("CPB_COMMIT_SIZE_MAX_FILES"),
      minBodyChars: envInt("CPB_COMMIT_SIZE_MIN_BODY_CHARS"),
      override: process.env.CPB_COMMIT_SIZE_OVERRIDE,
    },
  );

  if (result.ok) {
    if (result.overridden) {
      console.warn(
        `commit-size gate: OVERRIDDEN (${(process.env.CPB_COMMIT_SIZE_OVERRIDE ?? "").trim()}). HEAD = ${files} files / ${churn} lines.`,
      );
    } else {
      console.log(`commit-size gate passed: ${files} files / ${churn} changed lines.`);
    }
    return;
  }

  console.error("commit-size gate FAILED. HEAD commit is too large and has no explanatory body:\n");
  for (const reason of result.reasons) console.error(`  - ${reason}`);
  console.error("\nDecompose the commit, or add a multi-line message body explaining it.");
  console.error('Set CPB_COMMIT_SIZE_OVERRIDE="<reason>" to bypass loudly for a legitimate bulk commit.');
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
