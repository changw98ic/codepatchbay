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
  console.log(`  ${CYAN}init${NC} <path> [name]                  Initialize project`);
  console.log(`  ${CYAN}attach${NC} [path] [name]                  Attach project to Hub`);
  console.log(`  ${CYAN}hub${NC} [status|start|stop|projects|...]  Hub management`);
  console.log(`  ${CYAN}codegraph${NC} [status|start|stop]         CodeGraph MCP server`);
  console.log(`  ${CYAN}pipeline${NC} [--interactive] <project> "<task>" [retries]  Full pipeline`);
  console.log(`  ${CYAN}run${NC} "<task>" [--project <id>]         Run task (pipeline alias)`);
  console.log(`  ${CYAN}demo${NC} [--json]                         Local mock plan/diff/tests/verdict/risk demo`);
  console.log(`  ${CYAN}research${NC} <project> "<task>"              Dual-agent research`);
  console.log(`  ${CYAN}evolve-multi${NC} [--once|--scan|--continuous] [options]  Multi-phase evolution`);
  console.log(`  ${CYAN}index${NC} <status|refresh|graph|impact|context-pack> <project> [args] [--json]  Project code index and graph`);
  console.log(`  ${CYAN}sdd${NC} <init|bootstrap|verify|drift> <project> [--json]  Spec-driven development skeleton`);
  console.log(`  ${CYAN}repair${NC} <project> <job-id> [--agent <name>]  Retry job phase`);
  console.log(`  ${CYAN}status${NC} <project>                       Project status`);
  console.log(`  ${CYAN}list${NC}                                   List projects`);
  console.log(`  ${CYAN}jobs${NC} [reconcile|cleanup|report]         Job management`);
  console.log(`  ${CYAN}artifacts${NC} <job-id> [--json]              List job artifacts`);
  console.log(`  ${CYAN}verdict${NC} <job-id> [--json]                Show job verdict`);
  console.log(`  ${CYAN}gc${NC} [--dry-run]                          Clean stale jobs, orphan leases, pollution`);
  console.log(`  ${CYAN}recover${NC} [--dry-run]                     Alias for gc`);
  console.log(`  ${CYAN}diff${NC} <project>                         Git diff`);
  console.log(`  ${CYAN}review${NC} <project> [id] [--agent]          Review deliverable`);
  console.log(`  ${CYAN}inbox${NC} <project>                        List plans`);
  console.log(`  ${CYAN}outputs${NC} <project>                      List outputs`);
  console.log(`  ${CYAN}setup${NC} [--json]                         Run the setup wizard`);
  console.log(`  ${CYAN}agents${NC} [list|detect|install|test]       Agent gateway setup and checks`);
  console.log(`  ${CYAN}browser${NC} <providers|show|login|logout|test|doctor|install|reset|diagnostics>  Browser agent management`);
  console.log(`  ${CYAN}auth${NC} [status]                            Provider-native auth checks`);
  console.log(`  ${CYAN}github${NC} [bind|connect|doctor]             GitHub integration: bind, connect, health`);
  console.log(`  ${CYAN}doctor${NC} [--json]                         Health check`);
  console.log(`  ${CYAN}health-check${NC}                            HTTP + test + build check`);
  console.log(`  ${CYAN}wiki${NC} [lint|list|experience ...]         Wiki operations`);
  console.log(`  ${CYAN}release${NC} <list|use|install|doctor|gc>    Release management`);
  console.log(`  ${CYAN}cancel${NC} <project> <jobId> [reason]      Cancel a running job`);
  console.log(`  ${CYAN}redirect${NC} <project> <jobId> "<msg>" [reason]  Redirect a job`);
  console.log(`  ${CYAN}merge-preview${NC} <project> <ref> [--base <branch>] [--json]  Preview merge`);
  console.log(`  ${CYAN}install-bin${NC}                              Install cpb to PATH`);
  console.log(`  ${CYAN}ui${NC} [--port] [--host]                   Start Web UI`);
  console.log(`  ${CYAN}backlog-hygiene${NC} [--dry-run] [--repo <owner/repo>]  Mark stale CPB comments, close superseded issues`);
  console.log(`  ${CYAN}audit${NC} <project> <job-id> [--json] [--out <dir>]  Export audit package`);
  console.log(`  ${CYAN}review-bundle${NC} <project> <job-id> [--json] [--out <dir>]  Local review bundle`);
  console.log(`  ${CYAN}logs${NC} [--follow] [--worker <id>] [--job <id>] [--level <lvl>] [--since <5m|1h|1d>]  View logs`);
  console.log(`  ${CYAN}profile${NC} [list|show|use]                Profile management`);
  console.log(`  ${CYAN}version${NC}                                 Show version`);
  console.log("");
  console.log(`${BOLD}Global flags:${NC}`);
  console.log(`  ${YELLOW}--dangerous${NC}                            Remove ACP constraints`);
}

async function checkDeps() {
  const missing = [];
  try {
    await access(path.join(CPB_EXECUTOR_ROOT, "server", "services", "acp-client-core.mjs"), constants.R_OK);
  } catch {
    missing.push("server/services/acp-client-core.mjs");
  }
  if (missing.length > 0) {
    console.log(`${YELLOW}Missing:${NC}`);
    for (const d of missing) console.log(`  - ${d}`);
    process.exit(1);
  }
  console.log(`${GREEN}ACP client ready.${NC}`);
}

// --- Command router ---

const COMMANDS = {
  init: "init.js",
  attach: "attach.js",
  hub: "hub.js",
  pipeline: "pipeline.js",
  profile: "profile.js",
  run: "run.js",
  demo: "demo.js",
  research: "research.js",
  status: "status.js",
  list: "list.js",
  jobs: "jobs.js",
  artifacts: "artifacts.js",
  verdict: "verdict.js",
  "evolve-multi": "evolve-multi.js",
  index: "index.js",
  sdd: "sdd.js",
  repair: "repair.js",
  diff: "diff.js",
  review: "review.js",
  inbox: "inbox.js",
  outputs: "outputs.js",
  setup: "setup.js",
  agents: "agents.js",
  browser: "browser.js",
  auth: "auth.js",
  github: "github.js",
  doctor: "doctor.js",
  "health-check": "health-check.js",
  gc: "reconcile.js",
  recover: "reconcile.js",
  wiki: "wiki.js",
  ui: "ui.js",
  version: "version.js",
  cancel: "cancel-redirect.js",
  redirect: "cancel-redirect.js",
  "merge-preview": "merge-preview.js",
  release: "release-select.js",
  config: "config.js",
  provider: "provider.js",
  quickstart: "quickstart.js",
  "model-profile": "model-profile.js",
  "install-bin": "install-bin.js",
  audit: "audit.js",
  "review-bundle": "review-bundle.js",
  "backlog-hygiene": "backlog-hygiene.js",
  codegraph: "codegraph.js",
  "hub-orch": "hub-orch.js",
  logs: "logs.js",
};

// --- Main ---

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

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    usage();
    console.log("");
    await checkDeps();
    return args.length === 0 ? undefined : 0;
  }

  let cmd = args[0];
  const cmdArgs = args.slice(1);

  if (cmd === "--version") {
    cmd = "version";
  }

  const mod = cmd in COMMANDS ? await import(path.join(CPB_EXECUTOR_ROOT, "cli", "commands", COMMANDS[cmd])) : null;

  // Resolve per-project runtime root from hub registry for project-scoped commands
  if (!process.env.CPB_PROJECT_RUNTIME_ROOT) {
    const PROJECT_COMMANDS = new Set(["pipeline", "run", "research", "status", "repair", "diff", "review", "inbox", "outputs", "index", "sdd", "cancel", "redirect", "merge-preview", "config", "review-bundle", "audit"]);
    if (PROJECT_COMMANDS.has(cmd)) {
      let projectArg = cmdArgs.find((a) => !a.startsWith("-"));
      // Commands like `run` pass project via --project flag, not positionally
      const projectFlagIdx = cmdArgs.indexOf("--project");
      if (projectFlagIdx >= 0 && cmdArgs[projectFlagIdx + 1]) {
        projectArg = cmdArgs[projectFlagIdx + 1];
      }
      if (projectArg) {
        try {
          const { resolveHubRoot, getProject } = await import(path.join(CPB_EXECUTOR_ROOT, "server", "services", "hub-registry.js"));
          const hubRoot = resolveHubRoot(CPB_ROOT);
          const project = await getProject(hubRoot, projectArg);
          if (project?.projectRuntimeRoot) {
            process.env.CPB_PROJECT_RUNTIME_ROOT = project.projectRuntimeRoot;
          }
        } catch {}
      }
    }
  }

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
    const result = await mod.run(cmdArgs, { cpbRoot: CPB_ROOT, executorRoot: CPB_EXECUTOR_ROOT, command: cmd });
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
