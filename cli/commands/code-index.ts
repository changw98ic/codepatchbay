#!/usr/bin/env node
// cli/commands/code-index.ts — canonical Local Code Index v2 CLI

import path from "node:path";

import type { LooseRecord } from "../../shared/types.js";
import {
  LocalCodeIndexUnavailableError,
  ensureLocalCodeIndex,
  localCodeIndexStatus,
  queryLocalCodeIndex,
  resolveStorageRoot,
  repositoryObjectsLockDir,
  worktreeLockDir,
} from "../../core/indexing/local-code-index/index.js";
import type {
  LocalCodeIndexQuery,
  LocalCodeIndexQueryResult,
  LocalCodeIndexStatus,
} from "../../core/indexing/local-code-index/index.js";
import { garbageCollect } from "../../core/indexing/local-code-index/gc.js";
import {
  inspectIndexLock,
  repairIndexLock,
} from "../../core/indexing/local-code-index/management.js";
import type { RepairAction } from "../../core/indexing/local-code-index/management.js";
import {
  buildLocalCodeIndexEvidence,
  taskSymbolCandidates,
} from "../../core/indexing/local-code-index/evidence.js";

type CliExitCode = 0 | 1 | 2;

class CliUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CliUnavailableError";
  }
}

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

type ParsedCommon =
  | Readonly<{
      ok: true;
      sourcePath: string;
      cpbRoot: string | undefined;
      json: boolean;
      remaining: string[];
    }>
  | Readonly<{ ok: false; message: string }>;

function parseCommon(
  args: string[],
  routerRoot: string | undefined,
  commandValueFlags: ReadonlySet<string> = new Set(),
): ParsedCommon {
  let explicitSource: string | undefined;
  let explicitRoot: string | undefined;
  let json = false;
  const positionals: string[] = [];
  const remaining: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--source" || arg === "-s") {
      const value = args[++index];
      if (!value) return { ok: false, message: `${arg} requires a path` };
      if (explicitSource !== undefined) {
        return { ok: false, message: "source may be specified only once" };
      }
      explicitSource = value;
      continue;
    }
    if (arg === "--cpb-root") {
      const value = args[++index];
      if (!value) return { ok: false, message: "--cpb-root requires a path" };
      if (explicitRoot !== undefined) {
        return { ok: false, message: "--cpb-root may be specified only once" };
      }
      explicitRoot = value;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (commandValueFlags.has(arg)) {
      const value = args[++index];
      if (!value) return { ok: false, message: `${arg} requires a value` };
      remaining.push(arg, value);
      continue;
    }
    if (arg.startsWith("-")) {
      remaining.push(arg);
      continue;
    }
    positionals.push(arg);
  }

  if (explicitSource !== undefined && positionals.length > 0) {
    return {
      ok: false,
      message: "use either a positional source path or --source, not both",
    };
  }
  if (positionals.length > 1) {
    return { ok: false, message: "only one positional source path is allowed" };
  }

  return {
    ok: true,
    sourcePath: path.resolve(explicitSource ?? positionals[0] ?? process.cwd()),
    cpbRoot: explicitRoot
      ? path.resolve(explicitRoot)
      : routerRoot
        ? path.resolve(routerRoot)
        : undefined,
    json,
    remaining,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printStatusHuman(status: LocalCodeIndexStatus): void {
  if (!status.available) {
    console.error(`${RED}Status: unavailable${NC}`);
    console.error(`  Available: false`);
    console.error(`  Fresh:  false`);
    console.error(`  Exact:  false`);
    console.error(`  Reason: ${status.reason}`);
    return;
  }
  console.log(`${status.fresh ? GREEN : RED}Status: ${status.fresh ? "available" : "stale"}${NC}`);
  console.log(`  Available: true`);
  console.log(`  Fresh:    ${status.fresh}`);
  console.log(`  Exact:    ${status.exact}`);
  console.log(`  Reason:   ${status.reason ?? "none"}`);
  console.log(`  Snapshot: ${status.ref.snapshotId}`);
  console.log(`  Files:    ${status.files}`);
}

function statusExitCode(status: LocalCodeIndexStatus): CliExitCode {
  return status.available && status.fresh && status.exact ? 0 : 1;
}

async function statusCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot);
  if ("message" in parsed) return syntaxError(parsed.message);
  if (parsed.remaining.length > 0) {
    return syntaxError(`unknown option: ${parsed.remaining[0]}`);
  }
  const status = await localCodeIndexStatus({
    sourcePath: parsed.sourcePath,
    cpbRoot: parsed.cpbRoot,
  });
  if (parsed.json) printJson(status);
  else printStatusHuman(status);
  return statusExitCode(status);
}

async function buildCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot);
  if ("message" in parsed) return syntaxError(parsed.message);
  if (parsed.remaining.some((option) => option !== "--force")) {
    return syntaxError(`unknown option: ${parsed.remaining.find((option) => option !== "--force")}`);
  }
  if (parsed.remaining.filter((option) => option === "--force").length > 1) {
    return syntaxError("--force may be specified only once");
  }
  const force = parsed.remaining.includes("--force");
  const result = await ensureLocalCodeIndex({
    sourcePath: parsed.sourcePath,
    cpbRoot: parsed.cpbRoot,
    force,
  });
  if (parsed.json) {
    printJson(result);
  } else {
    console.log(`${GREEN}Index built${NC}`);
    console.log(`  Source:   ${result.ref.sourcePath}`);
    console.log(`  Snapshot: ${result.ref.snapshotId}`);
    console.log(`  Mode:     ${result.stats.mode}`);
    console.log(`  Files:    ${result.stats.discoveredFiles}`);
    console.log(`  Parsed:   ${result.stats.parsedFiles}`);
  }
  return 0;
}

const QUERY_VALUE_FLAGS = new Set([
  "--definitions",
  "--references",
  "--imports",
  "--file-summary",
  "--related-file",
  "--limit",
]);

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1] !== undefined) {
      values.push(args[++index]!);
    }
  }
  return values;
}

function parseLimit(args: string[]): number | undefined {
  const values = optionValues(args, "--limit");
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new Error("--limit may be specified only once");
  const value = Number(values[0]);
  if (!Number.isInteger(value)) throw new Error("--limit must be an integer");
  return value;
}

function parseQuery(args: string[]): LocalCodeIndexQuery {
  const selectors = [
    "--definitions",
    "--references",
    "--imports",
    "--file-summary",
    "--related-file",
    "--inventory",
  ].filter((flag) => args.includes(flag));
  if (selectors.length !== 1) {
    throw new Error("query requires exactly one query selector");
  }
  const selector = selectors[0]!;
  const limit = parseLimit(args);
  switch (selector) {
    case "--definitions":
      return {
        kind: "definitions",
        symbol: optionValues(args, selector)[0]!,
        match: "exact",
        ...(limit === undefined ? {} : { limit }),
      };
    case "--references":
      return {
        kind: "references",
        symbol: optionValues(args, selector)[0]!,
        match: "exact",
        ...(limit === undefined ? {} : { limit }),
      };
    case "--imports":
      return {
        kind: "imports",
        path: optionValues(args, selector)[0]!,
        ...(limit === undefined ? {} : { limit }),
      };
    case "--file-summary":
      return { kind: "file-summary", path: optionValues(args, selector)[0]! };
    case "--related-file":
      return {
        kind: "related-files",
        paths: optionValues(args, selector),
        ...(limit === undefined ? {} : { limit }),
      };
    case "--inventory":
      return {
        kind: "inventory",
        ...(limit === undefined ? {} : { limit }),
      };
    default:
      throw new Error("unsupported query selector");
  }
}

function printQueryHuman(result: LocalCodeIndexQueryResult): void {
  console.log(`${GREEN}${result.kind}${NC} [${result.snapshotId}]`);
  switch (result.kind) {
    case "definitions":
    case "references":
      for (const item of result.occurrences) {
        console.log(`  ${CYAN}${item.symbol}${NC} ${item.path}:${item.range.startLine}`);
      }
      break;
    case "imports":
      for (const item of result.relationships) {
        console.log(`  ${item.fromPath} -> ${item.toPath}`);
      }
      break;
    case "file-summary":
      console.log(result.file ? `  ${result.file.path}` : "  no file");
      break;
    case "related-files":
      for (const item of result.files) console.log(`  ${item.path} (${item.score})`);
      break;
    case "inventory":
      for (const item of result.files) console.log(`  ${item.path}`);
      break;
  }
}

async function requireFreshStatus(
  sourcePath: string,
  cpbRoot: string | undefined,
): Promise<LocalCodeIndexStatus & { available: true; fresh: true }> {
  const status = await localCodeIndexStatus({ sourcePath, cpbRoot });
  if (!status.available || !status.fresh) {
    throw new CliUnavailableError(status.reason ?? "missing_local_code_index");
  }
  return status as LocalCodeIndexStatus & { available: true; fresh: true };
}

async function queryCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot, QUERY_VALUE_FLAGS);
  if ("message" in parsed) return syntaxError(parsed.message);
  let query: LocalCodeIndexQuery;
  try {
    query = parseQuery(parsed.remaining);
  } catch (error: unknown) {
    return syntaxError(error instanceof Error ? error.message : String(error));
  }
  const status = await requireFreshStatus(parsed.sourcePath, parsed.cpbRoot);
  const result = await queryLocalCodeIndex(status.ref, query, {
    cpbRoot: parsed.cpbRoot,
  });
  if (parsed.json) printJson(result);
  else printQueryHuman(result);
  return 0;
}

async function inspectCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot);
  if ("message" in parsed) return syntaxError(parsed.message);
  if (parsed.remaining.length > 0) {
    return syntaxError(`unknown option: ${parsed.remaining[0]}`);
  }
  const status = await localCodeIndexStatus({
    sourcePath: parsed.sourcePath,
    cpbRoot: parsed.cpbRoot,
  });
  if (parsed.json) printJson(status);
  else printStatusHuman(status);
  return statusExitCode(status);
}

async function gcCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot);
  if ("message" in parsed) return syntaxError(parsed.message);
  if (parsed.remaining.length > 0) {
    return syntaxError(`unknown option: ${parsed.remaining[0]}`);
  }
  const status = await requireFreshStatus(parsed.sourcePath, parsed.cpbRoot);
  const storageRoot = await resolveStorageRoot(parsed.cpbRoot, parsed.sourcePath);
  const result = await garbageCollect({
    storageRoot,
    repositoryKey: status.ref.repositoryKey,
  });
  if (parsed.json) printJson(result);
  else console.log(`${GREEN}GC complete${NC}\n  Deleted objects: ${result.deletedObjects}`);
  return 0;
}

async function inspectLockCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot, new Set(["--scope"]));
  if ("message" in parsed) return syntaxError(parsed.message);
  const scopes = optionValues(parsed.remaining, "--scope");
  if (scopes.length > 1) {
    return syntaxError("--scope may be specified only once");
  }
  const scope = scopes[0] ?? "worktree";
  if (scope !== "worktree" && scope !== "repository") {
    return syntaxError("--scope must be worktree or repository");
  }
  const status = await requireFreshStatus(parsed.sourcePath, parsed.cpbRoot);
  const storageRoot = await resolveStorageRoot(parsed.cpbRoot, parsed.sourcePath);
  const lockDir = scope === "repository"
    ? repositoryObjectsLockDir(storageRoot, status.ref.repositoryKey)
    : worktreeLockDir(storageRoot, status.ref.worktreeKey);
  const descriptor = await inspectIndexLock(lockDir);
  if (parsed.json) printJson(descriptor);
  else console.log(`${GREEN}Lock: ${descriptor.state}${NC}\n  Path: ${descriptor.lockDir}`);
  return 0;
}

async function repairLockCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(
    args,
    routerRoot,
    new Set(["--scope", "--action", "--election-dir"]),
  );
  if ("message" in parsed) return syntaxError(parsed.message);
  const actions = optionValues(parsed.remaining, "--action");
  const scopes = optionValues(parsed.remaining, "--scope");
  const electionDirs = optionValues(parsed.remaining, "--election-dir");
  if (actions.length > 1) {
    return syntaxError("--action may be specified only once");
  }
  if (scopes.length > 1) {
    return syntaxError("--scope may be specified only once");
  }
  if (electionDirs.length > 1) {
    return syntaxError("--election-dir may be specified only once");
  }
  const action = actions[0] as RepairAction | undefined;
  if (!action || ![
    "quarantine-incomplete",
    "quarantine-stale",
    "quarantine-election",
  ].includes(action)) {
    return syntaxError("--action must name a supported quarantine action");
  }
  const scope = scopes[0] ?? "worktree";
  if (scope !== "worktree" && scope !== "repository") {
    return syntaxError("--scope must be worktree or repository");
  }
  if (action === "quarantine-election" && !electionDirs[0]) {
    return syntaxError("quarantine-election requires --election-dir");
  }
  if (action !== "quarantine-election" && electionDirs[0]) {
    return syntaxError("--election-dir is only valid with quarantine-election");
  }
  const status = await requireFreshStatus(parsed.sourcePath, parsed.cpbRoot);
  const storageRoot = await resolveStorageRoot(parsed.cpbRoot, parsed.sourcePath);
  const lockDir = scope === "repository"
    ? repositoryObjectsLockDir(storageRoot, status.ref.repositoryKey)
    : worktreeLockDir(storageRoot, status.ref.worktreeKey);
  const descriptor = await inspectIndexLock(lockDir);
  const result = await repairIndexLock({
    descriptor,
    action,
    ...(electionDirs[0]
      ? { electionDir: electionDirs[0] }
      : {}),
  });
  if (parsed.json) printJson(result);
  else console.log(`${GREEN}Lock repaired${NC}\n  Quarantine: ${result.quarantinePath}`);
  return 0;
}

async function evidenceCommand(
  args: string[],
  routerRoot: string | undefined,
): Promise<CliExitCode> {
  const parsed = parseCommon(args, routerRoot, new Set(["--task", "-t"]));
  if ("message" in parsed) return syntaxError(parsed.message);
  const task = optionValues(parsed.remaining, "--task")[0]
    ?? optionValues(parsed.remaining, "-t")[0];
  if (!task) return syntaxError("evidence requires --task <text>");
  const status = await requireFreshStatus(parsed.sourcePath, parsed.cpbRoot);
  const results: Record<string, LocalCodeIndexQueryResult> = {};
  const symbols = taskSymbolCandidates(task);
  if (symbols[0]) {
    results.definitions = await queryLocalCodeIndex(
      status.ref,
      { kind: "definitions", symbol: symbols[0], match: "exact" },
      { cpbRoot: parsed.cpbRoot },
    );
  }
  results.inventory = await queryLocalCodeIndex(
    status.ref,
    { kind: "inventory" },
    { cpbRoot: parsed.cpbRoot },
  );
  const evidence = buildLocalCodeIndexEvidence(results, task);
  if (parsed.json) printJson({ snapshotId: status.ref.snapshotId, evidence });
  else process.stdout.write(`${evidence}\n`);
  return 0;
}

function syntaxError(message: string): 2 {
  console.error(`${RED}Error: ${message}${NC}`);
  return 2;
}

function unavailableError(error: unknown, json: boolean): 1 {
  const reason = error instanceof LocalCodeIndexUnavailableError
    ? error.reason
    : error instanceof CliUnavailableError
      ? error.reason
      : "local_code_index_unavailable";
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    printJson({
      available: false,
      fresh: false,
      exact: false,
      reason,
      message,
    });
  } else {
    console.error(`${RED}Error: ${message}${NC}`);
    console.error(`  Reason: ${reason}`);
  }
  return 1;
}

const USAGE = `${BOLD}cpb code-index${NC} — canonical Local Code Index v2

${BOLD}Usage:${NC}
  cpb code-index build [source] [--source path] [--cpb-root path] [--json]
  cpb code-index status [source] [--source path] [--cpb-root path] [--json]
  cpb code-index query [source] --definitions symbol [--json]
  cpb code-index query [source] --references symbol [--json]
  cpb code-index query [source] --related-file path [--json]
  cpb code-index inspect [source] --json
  cpb code-index gc [source] [--json]
  cpb code-index inspect-lock [source] [--scope worktree|repository] [--json]
  cpb code-index repair-lock [source] --action action [--scope scope] [--json]
  cpb code-index evidence [source] --task text [--json]

${BOLD}Exit codes:${NC}
  0  operation completed with an available, fresh, exact index
  1  unavailable, stale, unsafe, invalid, or failed
  2  command syntax or argument error
`;

export async function run(
  args: string[],
  context: LooseRecord = {},
): Promise<CliExitCode> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(USAGE);
    return 0;
  }
  const command = args[0]!;
  const commandArgs = args.slice(1);
  const routerRoot = typeof context.cpbRoot === "string"
    ? context.cpbRoot
    : undefined;
  const json = commandArgs.includes("--json");

  try {
    switch (command) {
      case "build":
        return await buildCommand(commandArgs, routerRoot);
      case "status":
        return await statusCommand(commandArgs, routerRoot);
      case "query":
        return await queryCommand(commandArgs, routerRoot);
      case "inspect":
        return await inspectCommand(commandArgs, routerRoot);
      case "gc":
        return await gcCommand(commandArgs, routerRoot);
      case "inspect-lock":
        return await inspectLockCommand(commandArgs, routerRoot);
      case "repair-lock":
        return await repairLockCommand(commandArgs, routerRoot);
      case "evidence":
        return await evidenceCommand(commandArgs, routerRoot);
      default:
        return syntaxError(`unknown subcommand: ${command}`);
    }
  } catch (error: unknown) {
    return unavailableError(error, json);
  }
}
