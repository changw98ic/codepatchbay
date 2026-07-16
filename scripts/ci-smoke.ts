#!/usr/bin/env node
import { isRecord, recordValue, type LooseRecord } from "../shared/types.js";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CPB = path.join(ROOT, "cli", "cpb.js");
const HUB_SERVER = path.join(ROOT, "server", "index.js");

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";

type SmokeRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  command?: string;
  commandText?: string;
};

type RunOptions = {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

function run(cmd: string, args: string[], options: RunOptions = {}): Promise<SmokeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cmd, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        CPB_ROOT: ROOT,
        CPB_EXECUTOR_ROOT: ROOT,
        CPB_PROJECT_RUNTIME_ROOT: "",
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 60_000,
    });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    child.stdout.on("data", (d) => chunks.stdout.push(d));
    child.stderr.on("data", (d) => chunks.stderr.push(d));
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout: "", stderr: err.message });
    });
  });
}

type HubProcess = {
  child: ReturnType<typeof spawn>;
  output: () => { stdout: string; stderr: string };
  url: string;
};

function startHubProcess(hubRoot: string): Promise<HubProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HUB_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        CPB_ROOT: ROOT,
        CPB_EXECUTOR_ROOT: ROOT,
        CPB_HUB_ROOT: hubRoot,
        CPB_HOST: "127.0.0.1",
        CPB_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Hub start timed out. stdout=${snippet(stdout)} stderr=${snippet(stderr)}`));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/CodePatchbay Hub running at (http:\/\/[^\s]+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: match[1], output: () => ({ stdout, stderr }) });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Hub exited before ready (code=${code}, signal=${signal}). stderr=${snippet(stderr)}`));
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Hub did not stop within 10 seconds")), 10_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function snippet(text: string, maxLen = 500) {
  const s = text.trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "...";
}

function failContext(label: string, info: SmokeRunResult, detail: string | null) {
  const lines = [`${FAIL} ${label}`];
  lines.push(`  command: ${info.commandText}`);
  lines.push(`  exit code: ${info.code}`);
  if (info.stdout) lines.push(`  stdout: ${snippet(info.stdout)}`);
  if (info.stderr) lines.push(`  stderr: ${snippet(info.stderr)}`);
  if (detail) lines.push(`  validation error: ${detail}`);
  return lines.join("\n");
}

// --- validators ---

function validateSetup(data: LooseRecord) {
  const setup = recordValue(data.detected || data);
  if (!isRecord(setup.system)) return "missing or invalid detected .system";
  if (typeof setup.system.platform !== "string") return ".detected.system.platform is not a string";
  if (typeof setup.system.arch !== "string") return ".detected.system.arch is not a string";

  if (!isRecord(setup.agents)) return "missing or invalid detected .agents";
  for (const id of ["codex", "claude", "opencode"]) {
    const agent = recordValue(setup.agents[id]);
    if (!isRecord(setup.agents[id])) return `.detected.agents.${id} is missing`;
    if (typeof agent.installed !== "boolean") return `.detected.agents.${id}.installed is not boolean`;
  }
  if (data.detected) {
    if (data.schemaVersion !== 1) return ".schemaVersion must be 1";
    if (!data.profile || typeof data.profile !== "object") return "missing setup wizard .profile";
    if (data.executed !== false) return "cpb setup --json alone must not execute installs";
    if (!Array.isArray(data.selectedAgents)) return ".selectedAgents must be an array";
  }
  return null;
}

// --- runner ---

async function smoke(label: string, args: string[], validator: (data: LooseRecord) => string | null) {
  const result = await run(CPB, args);
  result.command = CPB;
  result.commandText = `node ${path.relative(ROOT, CPB)} ${args.join(" ")}`;

  if (result.code !== 0) {
    console.error(failContext(label, result, "non-zero exit code"));
    return false;
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    console.error(failContext(label, result, "stdout is not valid JSON"));
    return false;
  }

  const err = validator(data);
  if (err) {
    console.error(failContext(label, result, err));
    return false;
  }

  console.log(`${PASS} ${label}`);
  return true;
}

async function smokeHubLifecycle() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cpb-ci-hub-"));
  const hubRoot = path.join(tempRoot, "hub");
  let hub: HubProcess | null = null;
  try {
    hub = await startHubProcess(hubRoot);

    const response = await fetch(`${hub.url}/api/health`, { signal: AbortSignal.timeout(5_000) });
    const health = recordValue(await response.json());
    if (!response.ok || health.ok !== true || health.status !== "ok") {
      throw new Error(`Unexpected Hub health response: ${JSON.stringify(health)}`);
    }

    const projectsResponse = await fetch(`${hub.url}/api/projects`, { signal: AbortSignal.timeout(5_000) });
    const projects = await projectsResponse.json();
    if (!projectsResponse.ok || !Array.isArray(projects)) {
      throw new Error(`Unexpected Hub projects response: ${JSON.stringify(projects)}`);
    }

    const running = await run(CPB, ["hub", "status", "--json"], {
      env: { CPB_HUB_ROOT: hubRoot },
    });
    if (running.code !== 0) {
      throw new Error(`cpb hub status failed: ${snippet(running.stderr)}`);
    }
    const runningStatus = recordValue(JSON.parse(running.stdout));
    if (recordValue(runningStatus.liveness).alive !== true) {
      throw new Error(`Hub was not reported alive: ${running.stdout}`);
    }

    hub.child.kill("SIGTERM");
    await waitForExit(hub.child);

    const stopped = await run(CPB, ["hub", "status", "--json"], {
      env: { CPB_HUB_ROOT: hubRoot },
    });
    const stoppedStatus = recordValue(JSON.parse(stopped.stdout));
    if (stopped.code !== 0 || recordValue(stoppedStatus.liveness).alive !== false) {
      throw new Error(`Hub was not reported stopped: ${stopped.stdout || stopped.stderr}`);
    }

    console.log(`${PASS} Hub start, health, CLI status, and graceful stop`);
    return true;
  } catch (error) {
    const output = hub?.output() || { stdout: "", stderr: "" };
    console.error(`${FAIL} Hub lifecycle smoke: ${error instanceof Error ? error.message : String(error)}`);
    if (output.stdout) console.error(`  stdout: ${snippet(output.stdout)}`);
    if (output.stderr) console.error(`  stderr: ${snippet(output.stderr)}`);
    return false;
  } finally {
    if (hub && hub.child.exitCode === null && hub.child.signalCode === null) {
      hub.child.kill("SIGKILL");
      await waitForExit(hub.child).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function smokeHubCliLifecycle() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cpb-ci-hub-cli-"));
  const hubRoot = path.join(tempRoot, "hub");
  const env = {
    CPB_HUB_ROOT: hubRoot,
    CPB_HOST: "0.0.0.0",
    CPB_PORT: "0",
    CPB_HUB_BEARER_TOKEN: "ci-hub-bearer-token-with-at-least-32-bytes",
    CPB_HUB_ALLOW_INSECURE_HTTP: "1",
  };
  try {
    const started = await run(CPB, ["hub", "start"], { env, timeout: 30_000 });
    if (started.code !== 0) {
      throw new Error(`cpb hub start failed: ${snippet(started.stderr || started.stdout)}`);
    }

    const running = await run(CPB, ["hub", "status", "--json"], { env });
    const runningStatus = recordValue(JSON.parse(running.stdout));
    if (running.code !== 0 || recordValue(runningStatus.liveness).alive !== true) {
      throw new Error(`cpb hub start did not produce a live Hub: ${running.stdout || running.stderr}`);
    }

    const stopped = await run(CPB, ["hub", "stop"], { env, timeout: 30_000 });
    if (stopped.code !== 0) {
      throw new Error(`cpb hub stop failed: ${snippet(stopped.stderr || stopped.stdout)}`);
    }

    const afterStop = await run(CPB, ["hub", "status", "--json"], { env });
    const stoppedStatus = recordValue(JSON.parse(afterStop.stdout));
    if (afterStop.code !== 0 || recordValue(stoppedStatus.liveness).alive !== false) {
      throw new Error(`cpb hub stop left the Hub alive: ${afterStop.stdout || afterStop.stderr}`);
    }

    console.log(`${PASS} authenticated cpb hub start/status/stop CLI lifecycle`);
    return true;
  } catch (error) {
    console.error(`${FAIL} Hub CLI lifecycle: ${error instanceof Error ? error.message : String(error)}`);
    await run(CPB, ["hub", "stop"], { env, timeout: 10_000 }).catch(() => null);
    return false;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function smokeHubBackupCli() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "cpb-ci-hub-backup-"));
  const hubRoot = path.join(tempRoot, "hub");
  const backupRoot = path.join(tempRoot, "backup");
  const statePath = path.join(hubRoot, "state.txt");
  const env = {
    CPB_HUB_ROOT: hubRoot,
    CPB_HUB_BACKUP_SIGNING_KEY: "ci-smoke-hub-backup-signing-key-at-least-32-bytes",
  };
  try {
    await mkdir(hubRoot, { recursive: true });
    await writeFile(statePath, "before-backup\n", "utf8");

    const backup = await run(CPB, ["hub", "backup", "--output", backupRoot, "--json"], { env, timeout: 30_000 });
    if (backup.code !== 0) throw new Error(`cpb hub backup failed: ${snippet(backup.stderr || backup.stdout)}`);
    const backupResult = recordValue(JSON.parse(backup.stdout));
    if (!recordValue(backupResult.manifest).snapshotId) throw new Error(`backup JSON lacks snapshot id: ${backup.stdout}`);

    const verified = await run(CPB, ["hub", "verify-backup", "--input", backupRoot, "--require-signature", "--json"], { env, timeout: 30_000 });
    if (verified.code !== 0) throw new Error(`cpb hub verify-backup failed: ${snippet(verified.stderr || verified.stdout)}`);

    await writeFile(statePath, "after-backup\n", "utf8");
    const refused = await run(CPB, ["hub", "restore", "--input", backupRoot, "--require-signature", "--json"], { env, timeout: 30_000 });
    if (refused.code === 0 || !/--force/.test(refused.stderr || refused.stdout)) {
      throw new Error(`cpb hub restore did not require --force: ${refused.stdout || refused.stderr}`);
    }

    const restored = await run(CPB, ["hub", "restore", "--input", backupRoot, "--force", "--require-signature", "--json"], { env, timeout: 30_000 });
    if (restored.code !== 0) throw new Error(`cpb hub restore failed: ${snippet(restored.stderr || restored.stdout)}`);
    if (await readFile(statePath, "utf8") !== "before-backup\n") throw new Error("restored Hub state did not match the snapshot");
    const restoredResult = recordValue(JSON.parse(restored.stdout));
    const restoredRoots = Array.isArray(restoredResult.restoredRoots) ? restoredResult.restoredRoots.map(recordValue) : [];
    if (!restoredRoots[0]?.rollbackPath) throw new Error(`restore JSON lacks rollback path: ${restored.stdout}`);

    const recovery = await run(CPB, ["hub", "recover-restore", "--json"], { env, timeout: 30_000 });
    if (recovery.code !== 0 || recordValue(JSON.parse(recovery.stdout)).recovered !== false) {
      throw new Error(`cpb hub recover-restore did not report a clean state: ${recovery.stdout || recovery.stderr}`);
    }

    console.log(`${PASS} signed Hub backup, verification, force guard, restore, rollback, and recovery CLI lifecycle`);
    return true;
  } catch (error) {
    console.error(`${FAIL} Hub backup CLI lifecycle: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const results = [
  await smoke("cpb setup --json", ["setup", "--json"], validateSetup),
  await smokeHubLifecycle(),
  await smokeHubCliLifecycle(),
  await smokeHubBackupCli(),
];

if (!results.every(Boolean)) {
  console.error(`\n${FAIL} Some smoke tests failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${PASS} All smoke tests passed.`);
}
