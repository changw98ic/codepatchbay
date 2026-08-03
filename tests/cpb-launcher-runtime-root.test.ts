import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { tempRoot } from "./helpers.js";

async function launcherFixture(label: string) {
  const root = await tempRoot(`cpb-launcher-${label}`);
  const packageRoot = path.join(root, "package");
  const binRoot = path.join(root, "bin");
  const runtimeRoot = path.join(root, "runtime");
  const launcherPath = path.join(packageRoot, "cpb");
  const linkedLauncherPath = path.join(binRoot, "cpb");
  await mkdir(path.join(packageRoot, "dist", "cli"), { recursive: true });
  await mkdir(path.join(packageRoot, "dist", "core"), { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ type: "module" })}\n`,
    "utf8",
  );
  await writeFile(
    launcherPath,
    await readFile(path.resolve("cpb"), "utf8"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(packageRoot, "dist", "core", "paths.js"),
    [
      'import os from "node:os";',
      'import path from "node:path";',
      "export function cpbHome() {",
      '  return process.env.CPB_HOME || path.join(os.homedir(), ".cpb");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "dist", "cli", "cpb.js"),
    [
      "export async function main() {",
      "  process.stdout.write(JSON.stringify({",
      "    cpbRoot: process.env.CPB_ROOT,",
      "    executorRoot: process.env.CPB_EXECUTOR_ROOT,",
      "  }));",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await symlink(launcherPath, linkedLauncherPath);
  return { packageRoot, linkedLauncherPath, runtimeRoot };
}

function runLauncher(launcherPath: string, overrides: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...overrides };
  delete env.CPB_ROOT;
  delete env.CPB_EXECUTOR_ROOT;
  if (overrides.CPB_ROOT !== undefined) env.CPB_ROOT = overrides.CPB_ROOT;
  if (overrides.CPB_EXECUTOR_ROOT !== undefined) {
    env.CPB_EXECUTOR_ROOT = overrides.CPB_EXECUTOR_ROOT;
  }
  const result = spawnSync(process.execPath, [launcherPath], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as { cpbRoot: string; executorRoot: string };
}

test("launcher keeps runtime data outside the installed package by default", async () => {
  const fixture = await launcherFixture("default-root");
  const result = runLauncher(fixture.linkedLauncherPath, {
    CPB_HOME: fixture.runtimeRoot,
  });

  assert.deepEqual(result, {
    cpbRoot: fixture.runtimeRoot,
    executorRoot: path.join(fixture.packageRoot, "dist"),
  });
});

test("launcher preserves explicitly configured runtime and executor roots", async () => {
  const fixture = await launcherFixture("explicit-roots");
  const explicitRuntimeRoot = path.join(fixture.runtimeRoot, "explicit-runtime");
  const explicitExecutorRoot = path.join(fixture.runtimeRoot, "explicit-executor");
  const result = runLauncher(fixture.linkedLauncherPath, {
    CPB_HOME: fixture.runtimeRoot,
    CPB_ROOT: explicitRuntimeRoot,
    CPB_EXECUTOR_ROOT: explicitExecutorRoot,
  });

  assert.deepEqual(result, {
    cpbRoot: explicitRuntimeRoot,
    executorRoot: explicitExecutorRoot,
  });
});
