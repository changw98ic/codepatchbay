#!/usr/bin/env node

// Health check: test suite + fake ACP smoke
// Exit 0 = healthy, exit 1 = unhealthy

import { spawn } from "node:child_process";
import path from "node:path";

type CommandResult = { ok: boolean; output: string };
type HealthCheckResult = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  artifacts?: any;
  error?: string;
};
type HealthOptions = ReturnType<typeof parseArgs>;
type HealthContext = Record<string, any>;

function usage() {
  return [
    "Usage: cpb health-check [options]",
    "",
    "Options:",
    "  --skip-tests               Skip backend test command",
    "  --fake-acp-smoke           Run repeatable init/attach/pipeline/review/verify smoke with fake ACP",
    "  --help                     Show this help",
  ].join("\n");
}

export function parseArgs(args: string[] = [], env = process.env) {
  const options = {
    skipTests: false,
    fakeAcpSmoke: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--skip-tests":
        options.skipTests = true;
        break;
      case "--fake-acp-smoke":
        options.fakeAcpSmoke = true;
        break;
      default:
        throw new Error(`unknown health-check option: ${arg}`);
    }
  }

  return options;
}

function runCmd(cmd: string, args: string[], cwd = process.cwd()): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, output }));
  });
}

export async function check({
  cpbRoot,
  executorRoot,
  options,
  runCmdFn = runCmd,
  fakeAcpSmokeFn = null,
}: {
  cpbRoot: string;
  executorRoot: string;
  options: HealthOptions;
  runCmdFn?: (cmd: string, args: string[], cwd?: string) => Promise<CommandResult>;
  fakeAcpSmokeFn?: ((args: Record<string, any>) => Promise<any>) | null;
}) {
  const checks: HealthCheckResult[] = [];

  // Check 1: Backend tests
  if (!options.skipTests) {
    const tests = await runCmdFn("npm", ["run", "test:node"], cpbRoot);
    checks.push({ name: "tests", ok: tests.ok });
    if (!tests.ok) console.log("FAIL: tests\n" + tests.output.slice(-500));
  }

  // Check 2: repeatable fake ACP smoke
  if (options.fakeAcpSmoke) {
    try {
      let runFakeAcpSmoke = fakeAcpSmokeFn;
      if (!runFakeAcpSmoke) {
        ({ runFakeAcpSmoke } = await import("../../server/services/infra.js"));
      }
      const smoke = await runFakeAcpSmoke({ executorRoot: executorRoot || cpbRoot });
      checks.push({ name: "fake-acp-smoke", ok: smoke.ok, artifacts: smoke.artifacts });
      console.log(`PASS: fake-acp-smoke (${smoke.artifacts.inbox.length} inbox, ${smoke.artifacts.outputs.length} outputs)`);
    } catch (err) {
      const message = (err as Error).message;
      checks.push({ name: "fake-acp-smoke", ok: false, error: message });
      console.log("FAIL: fake-acp-smoke\n" + message.slice(-1000));
    }
  }

  return checks;
}

export async function run(args: string[] = [], { cpbRoot, executorRoot, runCmdFn, fakeAcpSmokeFn }: HealthContext = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const root = path.resolve(cpbRoot || process.env.CPB_ROOT || ".");
  const execRoot = path.resolve(executorRoot || process.env.CPB_EXECUTOR_ROOT || root);
  const checks = await check({
    cpbRoot: root,
    executorRoot: execRoot,
    options,
    runCmdFn,
    fakeAcpSmokeFn,
  });
  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "PASS" : `FAIL: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
  return allOk ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await run(process.argv.slice(2));
  if (Number.isInteger(code)) process.exitCode = code;
}
