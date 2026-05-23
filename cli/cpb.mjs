#!/usr/bin/env node
// cpb — CodePatchbay CLI (pure Node.js, replaces Bash entrypoint)
// Usage: node cli/cpb.mjs <command> [args...]

import { fileURLToPath } from "node:url";
import path from "node:path";
import { access, constants } from "node:fs/promises";

// Graceful EPIPE handling when piped to head/tail
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));
const CPB_EXECUTOR_ROOT = path.resolve(process.env.CPB_EXECUTOR_ROOT || CPB_ROOT);

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

function usage() {
  console.log(`${BOLD}cpb${NC} v0.2.0 — CodePatchbay (Node.js)`);
  console.log("");
  console.log(`${BOLD}Usage:${NC}`);
  console.log("  cpb <command> [arguments]");
  console.log("");
  console.log(`${BOLD}Commands:${NC}`);
  console.log(`  ${CYAN}init${NC} <path> <name>                    Initialize project`);
  console.log(`  ${CYAN}attach${NC} [path] [name]                  Attach project to Hub`);
  console.log(`  ${CYAN}hub${NC} [status|start|stop|projects|...]  Hub management`);
  console.log(`  ${CYAN}plan${NC} <project> "<task>"               Codex planning`);
  console.log(`  ${CYAN}execute${NC} <project> <plan-id>            Claude execution`);
  console.log(`  ${CYAN}verify${NC} <project> <deliverable-id>      Codex verification`);
  console.log(`  ${CYAN}pipeline${NC} [--interactive] <project> "<task>" [retries]  Full pipeline`);
  console.log(`  ${CYAN}research${NC} <project> "<task>"              Dual-agent research`);
  console.log(`  ${CYAN}status${NC} <project>                       Project status`);
  console.log(`  ${CYAN}list${NC}                                   List projects`);
  console.log(`  ${CYAN}jobs${NC} [reconcile|cleanup|report]         Job management`);
  console.log(`  ${CYAN}diff${NC} <project>                         Git diff`);
  console.log(`  ${CYAN}review${NC} <project> [id] [--agent]          Review deliverable`);
  console.log(`  ${CYAN}inbox${NC} <project>                        List plans`);
  console.log(`  ${CYAN}outputs${NC} <project>                      List outputs`);
  console.log(`  ${CYAN}doctor${NC} [--json]                         Health check`);
  console.log(`  ${CYAN}wiki${NC} [lint|list]                       Wiki operations`);
  console.log(`  ${CYAN}ui${NC} [--port] [--host]                   Start Web UI`);
  console.log(`  ${CYAN}version${NC}                                 Show version`);
  console.log("");
  console.log(`${BOLD}Global flags:${NC}`);
  console.log(`  ${YELLOW}--dangerous${NC}                            Remove ACP constraints`);
}

async function checkDeps() {
  const missing = [];
  try {
    await access(path.join(CPB_EXECUTOR_ROOT, "bridges", "acp-client.mjs"), constants.X_OK);
  } catch {
    missing.push("acp-client.mjs (run: chmod +x bridges/acp-client.mjs)");
  }
  if (missing.length > 0) {
    console.log(`${YELLOW}Missing:${NC}`);
    for (const d of missing) console.log(`  - ${d}`);
    process.exit(1);
  }
  console.log(`${GREEN}ACP client ready.${NC}`);
}

// ─── Command router ───

const COMMANDS = {
  init: "init.js",
  attach: "attach.js",
  hub: "hub.js",
  plan: "plan.js",
  execute: "execute.js",
  verify: "verify.js",
  pipeline: "pipeline.js",
  research: "research.js",
  status: "status.js",
  list: "list.js",
  jobs: "jobs.js",
  "evolve-multi": "evolve-multi.js",
  index: "index.js",
  repair: "repair.js",
  diff: "diff.js",
  review: "review.js",
  inbox: "inbox.js",
  outputs: "outputs.js",
  doctor: "doctor.js",
  wiki: "wiki.js",
  ui: "ui.js",
  version: "version.js",
  release: "release-select.js",
  "install-bin": "install-bin.js",
};

// ─── Main ───

async function main() {
  const rawArgs = process.argv.slice(2);

  // Parse global flags
  const args = [];
  for (const arg of rawArgs) {
    if (arg === "--dangerous") {
      process.env.CPB_DANGEROUS = "1";
    } else {
      args.push(arg);
    }
  }

  if (args.length === 0) {
    usage();
    console.log("");
    await checkDeps();
    return;
  }

  let cmd = args[0];
  const cmdArgs = args.slice(1);

  if (cmd === "--version") {
    cmd = "version";
  }

  const mod = cmd in COMMANDS ? await import(path.join(CPB_EXECUTOR_ROOT, "cli", "commands", COMMANDS[cmd])) : null;

  if (!mod) {
    console.error(`${RED}Unknown command: ${cmd}${NC}`);
    usage();
    return 1;
  }

  if (typeof mod.run !== "function") {
    console.error(`${RED}Command module missing run(): ${cmd}${NC}`);
    return 1;
  }

  try {
    const result = await mod.run(cmdArgs, { cpbRoot: CPB_ROOT, executorRoot: CPB_EXECUTOR_ROOT });
    return Number.isInteger(result) ? result : 0;
  } catch (err) {
    console.error(`${RED}Error:${NC}`, err.message);
    if (process.env.DEBUG) console.error(err.stack);
    return 1;
  }
}

export { main };

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  if (Number.isInteger(code)) process.exitCode = code;
}
