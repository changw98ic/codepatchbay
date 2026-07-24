#!/usr/bin/env node
// cpb — CodePatchbay CLI (pure Node.js, replaces Bash entrypoint)
// Usage: ./cpb <command> [args...]

import { fileURLToPath } from "node:url";
import path from "node:path";
import { access, constants, readFile } from "node:fs/promises";

// Graceful EPIPE handling when piped to head/tail
process.stdout.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
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

async function readCliVersion() {
  try {
    const raw = await readFile(path.join(CPB_EXECUTOR_ROOT, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function usage() {
  const version = await readCliVersion();
  console.log(`${BOLD}cpb${NC} v${version} — CodePatchbay (Node.js)`);
  console.log("");
  console.log(`${BOLD}Usage:${NC}`);
  console.log("  cpb <command> [arguments]");
  console.log("");
  console.log(`${BOLD}Commands:${NC}`);
  console.log(`  ${CYAN}init${NC} <path> [name]                  Initialize project`);
  console.log(`  ${CYAN}hub${NC} [status|start|stop|projects|...]  Hub management`);
  console.log(`  ${CYAN}pipeline${NC} <project> "<task>" [--retries <n>]  Full pipeline`);
  console.log(`  ${CYAN}run${NC} "<task>" [--project <id>]         Run task (pipeline alias)`);
  console.log(`  ${CYAN}retry${NC} <project> <job-id> [--agent <name>]  Retry job phase`);
  console.log(`  ${CYAN}status${NC} <project>                       Project status`);
  console.log(`  ${CYAN}list${NC}                                   List projects`);
  console.log(`  ${CYAN}jobs${NC} [report|worktrees]                 Job management`);
  console.log(`  ${CYAN}diff${NC} <project>                         Git diff`);
  console.log(`  ${CYAN}review${NC} <project> [id] [--agent]          Review deliverable`);
  console.log(`  ${CYAN}inbox${NC} <project> [read|ack|done|outputs]  Plans & outputs`);
  console.log(`  ${CYAN}setup${NC}                                 Run the setup wizard`);
  console.log(`  ${CYAN}agents${NC} [list|detect|install|upgrade|test] Agent gateway setup and checks`);
  console.log(`  ${CYAN}github${NC} [bind|connect|doctor]             GitHub integration`);
  console.log(`  ${CYAN}doctor${NC} [--json]                         Health check`);
  console.log(`  ${CYAN}stream${NC} [--port PORT] [--host HOST]       Start streaming server`);
  console.log(`  ${CYAN}cancel${NC} <project> <jobId> [reason]      Cancel a running job`);
  console.log(`  ${CYAN}redirect${NC} <project> <jobId> "<msg>"     Redirect a job`);
  console.log(`  ${CYAN}version${NC}                                 Show version`);
  console.log("");
  console.log(`${BOLD}Global flags:${NC}`);
  console.log(`  ${YELLOW}--dangerous${NC}                            Remove ACP constraints`);
}

async function checkDeps() {
  const missing = [];
  try {
    await access(path.join(CPB_EXECUTOR_ROOT, "server", "services", "acp", "acp-client.js"), constants.R_OK);
  } catch {
    missing.push("server/services/acp/acp-client.js");
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
  hub: "hub.js",
  pipeline: "pipeline.js",
  run: "pipeline.js",
  status: "status.js",
  list: "list.js",
  jobs: "jobs.js",
  retry: "retry.js",
  diff: "diff.js",
  review: "review.js",
  inbox: "inbox.js",
  outputs: "inbox.js",
  setup: "setup.js",
  agents: "agents.js",
  github: "github.js",
  doctor: "doctor.js",
  stream: "stream.js",
  cancel: "cancel-redirect.js",
  redirect: "cancel-redirect.js",
  version: "version.js",
};

// --- Main ---

export function projectArgForCommand(cmd: string, cmdArgs: string[]) {
  let projectArg = cmd === "run" ? null : cmdArgs.find((a) => !a.startsWith("-"));
  const projectFlagIdx = cmdArgs.indexOf("--project");
  if (projectFlagIdx >= 0 && cmdArgs[projectFlagIdx + 1]) {
    projectArg = cmdArgs[projectFlagIdx + 1];
  }
  return projectArg;
}

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
    await usage();
    console.log("");
    await checkDeps();
    return args.length === 0 ? undefined : 0;
  }

  let cmd = args[0];
  const cmdArgs = args.slice(1);

  if (cmd === "--version") {
    cmd = "version";
  }

  // quickstart is an alias for setup --quickstart
  if (cmd === "quickstart" || cmd === "health-check") {
    if (cmd === "quickstart") cmdArgs.unshift("--quickstart");
    cmd = cmd === "quickstart" ? "setup" : "doctor";
  }

  const mod = cmd in COMMANDS ? await import(path.join(CPB_EXECUTOR_ROOT, "cli", "commands", COMMANDS[cmd])) : null;

  if (!mod) {
    console.error(`${RED}Unknown command: ${cmd}${NC}`);
    await usage();
    return 1;
  }

  if (!process.env.CPB_PROJECT_RUNTIME_ROOT) {
    // Resolve per-project runtime root from hub registry for project-scoped commands
    const PROJECT_COMMANDS = new Set(["pipeline", "run", "status", "retry", "diff", "review", "inbox", "outputs", "cancel", "redirect"]);
    if (PROJECT_COMMANDS.has(cmd)) {
      // `run` resolves an omitted project from cwd/package.json inside the
      // pipeline command. Treating the task text as a positional project here
      // prevents that auto-detection from running.
      const projectArg = projectArgForCommand(cmd, cmdArgs);
      if (projectArg) {
        const { resolveHubRoot, getProject } = await import(path.join(CPB_EXECUTOR_ROOT, "server", "services", "hub", "hub-registry.js"));
        const hubRoot = resolveHubRoot(CPB_ROOT);
        const project = await getProject(hubRoot, projectArg);
        if (!project?.projectRuntimeRoot) {
          throw new Error(`project runtime root required for project '${projectArg}'`);
        }
        process.env.CPB_PROJECT_RUNTIME_ROOT = project.projectRuntimeRoot;
      }
    }
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
