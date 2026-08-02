#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const artifactRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.resolve(artifactRoot, "..");

type TestMode = "unit" | "e2e" | "live-e2e";

function testMode(file: string): TestMode | null {
  if (file.startsWith("tests/unit/")) return "unit";
  if (file.startsWith("tests/e2e/")) return "e2e";
  if (file.startsWith("tests/live-e2e/")) return "live-e2e";
  return null;
}

function normalizeRequestedFile(input: string): string {
  const resolved = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  const sourceRelative = path.relative(sourceRoot, resolved).split(path.sep).join("/");
  const artifactRelative = path.relative(artifactRoot, resolved).split(path.sep).join("/");
  const relative = sourceRelative.startsWith("../") ? artifactRelative : sourceRelative;
  return relative.replace(/^dist-tests\//, "").replace(/\.ts$/, ".js");
}

async function collectTests(directory: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return results;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectTests(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      results.push(path.relative(artifactRoot, fullPath).split(path.sep).join("/"));
    }
  }
  return results.sort();
}

function childEnvironment(): NodeJS.ProcessEnv {
  const liveEntries = Object.entries(process.env).filter(([key]) => (
    key === "CPB_LIVE_E2E" || key.startsWith("CPB_LIVE_E2E_")
  ));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CPB_")) delete env[key];
  }
  Object.assign(env, Object.fromEntries(liveEntries));
  env.CPB_WORKER_DISPATCH_ENABLED = "0";
  env.CPB_CHECKLIST_DECOMPOSE = "0";
  return env;
}

function stopProcessGroup(child: ReturnType<typeof spawn>) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // The test process already exited.
  }
}

async function runTests(files: string[], label: string, concurrency?: number) {
  if (files.length === 0) return;
  const args = [
    "--test",
    ...(concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`]),
    ...files.map((file) => path.resolve(artifactRoot, file)),
  ];
  const timeoutValue = Number(process.env.CPB_TEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
    ? timeoutValue
    : 45 * 60 * 1000;

  console.log(`Running ${label}: ${files.length} file(s)`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: sourceRoot,
      env: childEnvironment(),
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      stopProcessGroup(child);
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const stopForSignal = () => stopProcessGroup(child);
    process.once("SIGINT", stopForSignal);
    process.once("SIGTERM", stopForSignal);
    process.once("SIGHUP", stopForSignal);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGINT", stopForSignal);
      process.off("SIGTERM", stopForSignal);
      process.off("SIGHUP", stopForSignal);
      stopProcessGroup(child);
      if (signal) reject(new Error(`${label} terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`${label} exited with code ${code}`));
      else resolve();
    });
  });
}

const args = process.argv.slice(2);
const requestedModes: TestMode[] = [
  ...(args.includes("--unit") ? ["unit" as const] : []),
  ...(args.includes("--e2e") ? ["e2e" as const] : []),
  ...(args.includes("--live-e2e") ? ["live-e2e" as const] : []),
];
if (requestedModes.length > 1) {
  console.error("--unit, --e2e, and --live-e2e are mutually exclusive");
  process.exit(2);
}

const requestedFiles = args
  .filter((arg) => !arg.startsWith("-"))
  .map(normalizeRequestedFile);
const discovered = requestedFiles.length > 0
  ? requestedFiles
  : await collectTests(path.join(artifactRoot, "tests"));
const modes = requestedModes.length > 0 ? requestedModes : ["unit", "e2e"] satisfies TestMode[];
const selected = discovered.filter((file) => {
  const mode = testMode(file);
  return mode !== null && modes.includes(mode);
});

if (args.includes("--list")) {
  for (const file of selected) console.log(file);
  process.exit(0);
}
if (selected.length === 0) {
  console.error(`No ${modes.join(" or ")} test files found`);
  process.exit(1);
}
if (modes.includes("live-e2e") && process.env.CPB_LIVE_E2E !== "1") {
  console.error("Live provider tests require explicit opt-in: CPB_LIVE_E2E=1 npm run test:live:e2e");
  process.exit(1);
}

try {
  await runTests(selected.filter((file) => testMode(file) === "unit"), "unit tests");
  await runTests(selected.filter((file) => testMode(file) === "e2e"), "local end-to-end tests", 1);
  await runTests(selected.filter((file) => testMode(file) === "live-e2e"), "live provider end-to-end tests", 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
