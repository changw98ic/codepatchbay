#!/usr/bin/env node

// Health check: HTTP GET + test suite + frontend build
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
    "  --url <url>                 HTTP endpoint to probe (default: http://127.0.0.1:<port>/api/health)",
    "  --port <port>               Port used by the default HTTP endpoint",
    "  --http-attempts <n>         Number of HTTP attempts (default: 10)",
    "  --http-interval-ms <ms>     Delay between HTTP attempts (default: 3000)",
    "  --skip-http                Skip HTTP endpoint probe",
    "  --skip-tests               Skip backend test command",
    "  --skip-build               Skip frontend build command",
    "  --fake-acp-smoke           Run repeatable init/attach/pipeline/review/verify smoke with fake ACP",
    "  --help                     Show this help",
  ].join("\n");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseArgs(args: string[] = [], env = process.env) {
  const options = {
    port: positiveInt(env.CPB_PORT || "3456", 3456),
    url: null,
    httpAttempts: 10,
    httpIntervalMs: 3000,
    skipHttp: false,
    skipTests: false,
    skipBuild: false,
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
      case "--url":
        options.url = args[++index];
        break;
      case "--port":
        options.port = positiveInt(args[++index], options.port);
        break;
      case "--http-attempts":
        options.httpAttempts = positiveInt(args[++index], options.httpAttempts);
        break;
      case "--http-interval-ms":
        options.httpIntervalMs = positiveInt(args[++index], options.httpIntervalMs);
        break;
      case "--skip-http":
        options.skipHttp = true;
        break;
      case "--skip-tests":
        options.skipTests = true;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--fake-acp-smoke":
        options.fakeAcpSmoke = true;
        break;
      default:
        throw new Error(`unknown health-check option: ${arg}`);
    }
  }

  options.url ||= `http://127.0.0.1:${options.port}/api/health`;
  return options;
}

async function httpCheck(url: string, maxAttempts = 10, intervalMs = 3000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
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
  httpCheckFn = httpCheck,
  runCmdFn = runCmd,
  fakeAcpSmokeFn = null,
}: {
  cpbRoot: string;
  executorRoot: string;
  options: HealthOptions;
  httpCheckFn?: (url: string, maxAttempts?: number, intervalMs?: number) => Promise<boolean>;
  runCmdFn?: (cmd: string, args: string[], cwd?: string) => Promise<CommandResult>;
  fakeAcpSmokeFn?: ((args: Record<string, any>) => Promise<any>) | null;
}) {
  const checks: HealthCheckResult[] = [];

  // Check 1: HTTP
  if (options.skipHttp) {
    checks.push({ name: "http", ok: true, skipped: true });
  } else {
    const httpOk = await httpCheckFn(options.url, options.httpAttempts, options.httpIntervalMs);
    checks.push({ name: "http", ok: httpOk });
    if (!httpOk) {
      console.log("FAIL: HTTP health check failed");
      return checks;
    }
  }

  // Check 2: Backend tests
  if (!options.skipTests) {
    const tests = await runCmdFn("npm", ["run", "test:node"], cpbRoot);
    checks.push({ name: "tests", ok: tests.ok });
    if (!tests.ok) console.log("FAIL: tests\n" + tests.output.slice(-500));
  }

  // Check 3: Frontend build
  if (!options.skipBuild) {
    const build = await runCmdFn("npm", ["run", "build:web"], cpbRoot);
    checks.push({ name: "build", ok: build.ok });
    if (!build.ok) console.log("FAIL: build\n" + build.output.slice(-500));
  }

  // Check 4: repeatable fake ACP smoke
  if (options.fakeAcpSmoke) {
    try {
      let runFakeAcpSmoke = fakeAcpSmokeFn;
      if (!runFakeAcpSmoke) {
        ({ runFakeAcpSmoke } = await import("../../server/services/local-smoke.js"));
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

export async function run(args: string[] = [], { cpbRoot, executorRoot, httpCheckFn, runCmdFn, fakeAcpSmokeFn }: HealthContext = {}) {
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
    httpCheckFn,
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
