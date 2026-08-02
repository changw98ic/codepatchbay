import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const sourceRoot = path.resolve(import.meta.dirname, "../../..");
const productionRoot = path.join(sourceRoot, "dist");
const cpbCli = path.join(productionRoot, "cli", "cpb.js");
const serviceToken = "cpb-e2e-service-token-with-at-least-32-bytes";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCpb(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cpbCli, ...args], {
      cwd: sourceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cpb ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function writeServiceTokens(root: string) {
  const filePath = path.join(root, "hub-service-tokens.json");
  const tokenSha256 = createHash("sha256").update(serviceToken, "utf8").digest("hex");
  await writeFile(filePath, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens: [{
      id: "local-e2e",
      tokenSha256,
      scopes: ["hub:admin"],
      projects: "*",
    }],
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

function commandFailure(command: string, result: CommandResult) {
  return `${command} failed with ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

async function collectHubStartupDiagnostics(hubRoot: string) {
  const relativePaths = [
    "hub.log",
    "orchestrator.log",
    "quota-delegate.log",
    path.join("state", "hub.json"),
    path.join("state", "orchestrator.json"),
    path.join("providers", "delegate", "delegate.lock"),
  ];
  const diagnostics = await Promise.all(relativePaths.map(async (relativePath) => {
    try {
      const contents = await readFile(path.join(hubRoot, relativePath), "utf8");
      return `${relativePath}:\n${contents.trim() || "<empty>"}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return `${relativePath}: <unreadable: ${(error as Error).message}>`;
    }
  }));
  return diagnostics.filter((diagnostic): diagnostic is string => diagnostic !== null).join("\n\n")
    || "<no Hub startup diagnostics were written>";
}

async function readStartedHubUrl(hubRoot: string) {
  const hubLog = await readFile(path.join(hubRoot, "hub.log"), "utf8");
  const match = hubLog.match(/CodePatchbay Hub running at (http:\/\/\S+)/);
  assert.ok(match?.[1], `Hub log did not report its listening URL:\n${hubLog}`);
  return match[1];
}

test("the public CLI starts, reports, and stops a real Hub process", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-e2e-"));
  const hubRoot = path.join(temporaryRoot, "hub");
  const serviceTokensFile = await writeServiceTokens(temporaryRoot);
  const env = {
    ...process.env,
    CPB_ROOT: productionRoot,
    CPB_EXECUTOR_ROOT: productionRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_HOST: "127.0.0.1",
    CPB_PORT: "0",
    CPB_HUB_SERVICE_TOKENS_FILE: serviceTokensFile,
  };
  let hubMayBeRunning = false;

  try {
    const started = await runCpb(["hub", "start"], env);
    if (started.code !== 0) {
      const diagnostics = await collectHubStartupDiagnostics(hubRoot);
      assert.equal(started.code, 0, `${commandFailure("cpb hub start", started)}\nHub diagnostics:\n${diagnostics}`);
    }
    hubMayBeRunning = true;

    const hubUrl = await readStartedHubUrl(hubRoot);
    const healthResponse = await fetch(`${hubUrl}/api/health`, {
      headers: { authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as { ok?: unknown; status?: unknown };
    assert.deepEqual({ ok: health.ok, status: health.status }, { ok: true, status: "ok" });

    const running = await runCpb(["hub", "status", "--json"], env);
    assert.equal(running.code, 0, commandFailure("cpb hub status --json", running));
    assert.equal(JSON.parse(running.stdout).liveness.alive, true);

    const stopped = await runCpb(["hub", "stop"], env);
    assert.equal(stopped.code, 0, commandFailure("cpb hub stop", stopped));
    hubMayBeRunning = false;

    const afterStop = await runCpb(["hub", "status", "--json"], env);
    assert.equal(afterStop.code, 0, commandFailure("cpb hub status --json", afterStop));
    assert.equal(JSON.parse(afterStop.stdout).liveness.alive, false);
  } finally {
    if (hubMayBeRunning) await runCpb(["hub", "stop"], env).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the public CLI backs up and restores real Hub files", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-backup-e2e-"));
  const hubRoot = path.join(temporaryRoot, "hub");
  const backupRoot = path.join(temporaryRoot, "backup");
  const statePath = path.join(hubRoot, "state.txt");
  const env = {
    ...process.env,
    CPB_ROOT: productionRoot,
    CPB_EXECUTOR_ROOT: productionRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_HUB_BACKUP_SIGNING_KEY: "cpb-e2e-backup-signing-key-with-at-least-32-bytes",
  };

  try {
    await mkdir(hubRoot, { recursive: true });
    await writeFile(statePath, "before-backup\n", "utf8");

    const backup = await runCpb(["hub", "backup", "--output", backupRoot, "--json"], env);
    assert.equal(backup.code, 0, commandFailure("cpb hub backup", backup));

    await writeFile(statePath, "after-backup\n", "utf8");
    const restored = await runCpb([
      "hub",
      "restore",
      "--input",
      backupRoot,
      "--force",
      "--require-signature",
      "--json",
    ], env);
    assert.equal(restored.code, 0, commandFailure("cpb hub restore", restored));
    assert.equal(await readFile(statePath, "utf8"), "before-backup\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
