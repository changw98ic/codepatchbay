import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

import { projectArgForCommand } from "../cli/cpb.js";
import { parseCommonFlags } from "../cli/commands/pipeline.js";
import { resolveOutputsDir } from "../cli/commands/inbox.js";
import { resolveReviewWikiDir } from "../cli/commands/review.js";
import { captureProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

function runNpmScript(cwd: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn("npm", ["run", script, "--silent"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

async function makeIsolatedSource(prefix: string) {
  const sourceRoot = path.resolve(import.meta.dirname, "..", "..");
  const isolatedRoot = await tempRoot(prefix);
  const requiredEntries = [
    "bridges",
    "cli",
    "core",
    "runtime",
    "scripts",
    "server",
    "shared",
    "tests",
    "cpb",
    "package.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.tests.json",
  ];

  for (const entry of requiredEntries) {
    try {
      await cp(path.join(sourceRoot, entry), path.join(isolatedRoot, entry), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await symlink(path.join(sourceRoot, "node_modules"), path.join(isolatedRoot, "node_modules"), "dir");
  return isolatedRoot;
}

async function makeMinimalBuildSource(prefix: string) {
  const sourceRoot = path.resolve(import.meta.dirname, "..", "..");
  const isolatedRoot = await tempRoot(prefix);
  await mkdir(path.join(isolatedRoot, "scripts"), { recursive: true });
  await mkdir(path.join(isolatedRoot, "tests"), { recursive: true });
  await cp(
    path.join(sourceRoot, "scripts", "build-output.mjs"),
    path.join(isolatedRoot, "scripts", "build-output.mjs"),
  );
  await writeFile(path.join(isolatedRoot, "package.json"), `${JSON.stringify({
    name: "cpb-build-output-contract-fixture",
    version: "1.0.0",
    license: "MIT",
    type: "module",
    scripts: {
      "build:tests": "node scripts/build-output.mjs tests",
    },
  }, null, 2)}\n`, "utf8");
  const nodeConfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      rootDir: ".",
      outDir: "dist-tests",
      strict: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["scripts/**/*.ts", "tests/**/*.ts"],
    exclude: ["dist", "dist-tests", "node_modules"],
  };
  await writeFile(path.join(isolatedRoot, "tsconfig.node.json"), `${JSON.stringify(nodeConfig, null, 2)}\n`, "utf8");
  await writeFile(path.join(isolatedRoot, "tsconfig.tests.json"), `${JSON.stringify({
    extends: "./tsconfig.node.json",
    compilerOptions: { outDir: "dist-tests" },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(isolatedRoot, "scripts", "run-node-tests.ts"), "export {};\n", "utf8");
  await writeFile(path.join(isolatedRoot, "tests", "cli-runtime-contracts.test.ts"), "export {};\n", "utf8");
  await symlink(path.join(sourceRoot, "node_modules"), path.join(isolatedRoot, "node_modules"), "dir");
  return isolatedRoot;
}

async function buildFenceDescriptor(repoRoot: string, target = "tests") {
  const canonicalRoot = await realpath(repoRoot);
  const key = createHash("sha256")
    .update(`${canonicalRoot}\0${target}\0build-output-fence-v2`)
    .digest("hex");
  const digest = createHash("sha256").update(`${key}\0${0}`).digest();
  return {
    key,
    firstPort: 20_000 + (digest.readUInt16BE(0) % 40_000),
    protocol: "cpb-build-output-fence/v2 ",
  };
}

async function listenForBuildFenceTest(port: number, response: string) {
  const server = net.createServer((socket) => socket.end(response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return server;
}

async function closeBuildFenceTestServer(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function buildLockPath(repoRoot: string, target: "node" | "tests", lockRoot: string) {
  const repoHash = createHash("sha256").update(await realpath(repoRoot)).digest("hex").slice(0, 20);
  return path.join(lockRoot, `${repoHash}-${target}.lock`);
}

async function writeSyntheticLock(
  lockDir: string,
  options: {
    token: string;
    pid: number;
    repoRoot: string;
    target?: "node" | "tests";
    createdAt?: string;
    processIdentity?: {
      pid: number;
      birthId: string;
      incarnation: string;
      capturedAt: string;
      birthIdPrecision?: "exact" | "coarse";
      processGroupId?: number;
    };
  },
) {
  const capturedIdentity = options.processIdentity
    || (options.pid === process.pid
      ? captureProcessIdentity(process.pid, { strict: true })
      : {
          pid: options.pid,
          birthId: "synthetic-dead-generation",
          incarnation: `${options.pid}:synthetic-dead-generation`,
          capturedAt: new Date().toISOString(),
          birthIdPrecision: "exact" as const,
        });
  assert.ok(capturedIdentity);
  const processIdentity = options.processIdentity
    ? capturedIdentity
    : { ...capturedIdentity, birthIdPrecision: capturedIdentity.birthIdPrecision || "exact" };
  await mkdir(lockDir, { recursive: true });
  await mkdir(path.join(lockDir, `.owner-${options.token}`));
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
    version: 1,
    token: options.token,
    pid: options.pid,
    processIdentity,
    target: options.target || "tests",
    repoRoot: path.resolve(options.repoRoot),
    createdAt: options.createdAt || new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

async function waitForPath(filePath: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function transactionArtifacts(repoRoot: string, outDir: "dist" | "dist-tests") {
  const parent = path.dirname(repoRoot);
  const prefix = `.${path.basename(repoRoot)}-${outDir}.cpb-`;
  return (await readdir(parent)).filter((entry) => entry.startsWith(prefix));
}

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("run project resolution leaves task text available for auto-detection", () => {
  assert.equal(projectArgForCommand("run", ["fix failing tests"]), null);
  assert.equal(projectArgForCommand("run", ["fix failing tests", "--project", "myproj"]), "myproj");
  assert.equal(projectArgForCommand("pipeline", ["myproj", "fix failing tests"]), "myproj");
});

test("run flags are removed from the task positional list", () => {
  const parsed = parseCommonFlags([
    "fix failing tests",
    "--project",
    "myproj",
    "--model",
    "mimo",
    "--plan-agent",
    "claude",
    "--retries",
    "5",
  ]);

  assert.deepEqual(parsed.positional, ["fix failing tests"]);
  assert.equal(parsed.project, "myproj");
  assert.equal(parsed.model, "mimo");
  assert.equal(parsed.planAgent, "claude");
  assert.equal(parsed.retries, 5);
});

test("project output and review paths follow the registered runtime root", () => {
  const runtimeRoot = "/tmp/cpb-runtime/myproj";
  assert.equal(
    resolveOutputsDir("/tmp/cpb", "myproj", runtimeRoot),
    path.join(runtimeRoot, "wiki", "outputs"),
  );
  assert.equal(
    resolveReviewWikiDir("/tmp/cpb", "myproj", runtimeRoot),
    path.join(runtimeRoot, "wiki"),
  );
});

test("build:node refuses package-like trees before removing preinstalled dist", async () => {
  const packageRoot = await tempRoot("cpb-package-build-guard");
  const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"));
  const sentinel = path.join(packageRoot, "dist", "preinstalled-runtime.txt");

  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(sentinel, "must survive failed self-build\n", "utf8");

  const result = spawnSync("npm", ["run", "build:node", "--silent"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: tmpdir(),
    },
    timeout: 30_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /source checkout; refusing to remove dist/);
  assert.equal(await readFile(sentinel, "utf8"), "must survive failed self-build\n");
});

test("build:tests refuses package-like trees before removing preinstalled dist-tests", async () => {
  const packageRoot = await tempRoot("cpb-package-tests-build-guard");
  const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"));
  const sentinel = path.join(packageRoot, "dist-tests", "preinstalled-tests.txt");

  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(sentinel, "must survive failed self-build\n", "utf8");

  const result = spawnSync("npm", ["run", "build:tests", "--silent"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: tmpdir(),
    },
    timeout: 30_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /source checkout; refusing to remove dist-tests/);
  assert.equal(await readFile(sentinel, "utf8"), "must survive failed self-build\n");
});

test("build:node and build:tests can run concurrently without sharing output directories", async () => {
  const isolatedRoot = await makeIsolatedSource("cpb-parallel-build-guard");
  const [nodeBuild, testsBuild] = await Promise.all([
    runNpmScript(isolatedRoot, "build:node"),
    runNpmScript(isolatedRoot, "build:tests"),
  ]);

  assert.equal(nodeBuild.code, 0, `build:node failed (${nodeBuild.signal || nodeBuild.code}):\n${nodeBuild.output}`);
  assert.equal(testsBuild.code, 0, `build:tests failed (${testsBuild.signal || testsBuild.code}):\n${testsBuild.output}`);
  assert.match(await readFile(path.join(isolatedRoot, "dist", "package.json"), "utf8"), /"name": "codepatchbay"/);
  assert.match(await readFile(path.join(isolatedRoot, "dist", "scripts", "write-dist-metadata.js"), "utf8"), /distPackage/);
  assert.match(await readFile(path.join(isolatedRoot, "dist-tests", "tests", "cli-runtime-contracts.test.js"), "utf8"), /concurrently without sharing output directories/);
  assert.deepEqual(
    await readJson(path.join(isolatedRoot, "dist-tests", "package.json")),
    await readJson(path.join(isolatedRoot, "package.json")),
  );
  assert.equal(
    await readFile(path.join(isolatedRoot, "dist-tests", "core", "agents", "descriptors", "codex.json"), "utf8"),
    await readFile(path.join(isolatedRoot, "core", "agents", "descriptors", "codex.json"), "utf8"),
  );
  await access(path.join(isolatedRoot, "dist-tests", "scripts", "e2e-npm-pack.js"));
  await assert.rejects(
    access(path.join(isolatedRoot, "dist-tests", "scripts", "e2e-npm-pack.ts")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("compiled test runner executes tests from the source-checkout cwd", async () => {
  const sourceRoot = path.resolve(import.meta.dirname, "..", "..");
  const isolatedRoot = await tempRoot("cpb-test-runner-cwd");
  const canonicalIsolatedRoot = await realpath(isolatedRoot);
  const runner = path.join(isolatedRoot, "dist-tests", "scripts", "run-node-tests.js");
  const fixture = path.join(isolatedRoot, "dist-tests", "tests", "cwd-contract.test.js");
  await mkdir(path.dirname(runner), { recursive: true });
  await mkdir(path.dirname(fixture), { recursive: true });
  await cp(path.join(sourceRoot, "dist-tests", "scripts", "run-node-tests.js"), runner);
  await writeFile(
    fixture,
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest("cwd", () => assert.equal(process.cwd(), ${JSON.stringify(canonicalIsolatedRoot)}));\n`,
    "utf8",
  );

  const runnerEnv = { ...process.env };
  delete runnerEnv.NODE_TEST_CONTEXT;
  const result = await runNode([runner, "tests/cwd-contract.test.js"], isolatedRoot, runnerEnv);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
  assert.match(result.output, /pass 1/);
});

test("same-target build:tests calls serialize and keep published tests available", async () => {
  const isolatedRoot = await makeIsolatedSource("cpb-parallel-build-tests");
  const [first, second] = await Promise.all([
    runNpmScript(isolatedRoot, "build:tests"),
    runNpmScript(isolatedRoot, "build:tests"),
  ]);

  assert.equal(first.code, 0, `first build:tests failed (${first.signal || first.code}):\n${first.output}`);
  assert.equal(second.code, 0, `second build:tests failed (${second.signal || second.code}):\n${second.output}`);
  assert.match(await readFile(path.join(isolatedRoot, "dist-tests", ".cpb-build.json"), "utf8"), /"target": "tests"/);
  assert.match(await readFile(path.join(isolatedRoot, "dist-tests", "tests", "cli-runtime-contracts.test.js"), "utf8"), /same-target build:tests/);

  const [focused, third] = await Promise.all([
    runNode(["--test", path.join(isolatedRoot, "dist-tests", "tests", "job-projection.test.js")], isolatedRoot),
    runNpmScript(isolatedRoot, "build:tests"),
  ]);
  assert.equal(third.code, 0, `third same-fingerprint build:tests failed (${third.signal || third.code}):\n${third.output}`);
  assert.match(third.output, /up to date/);
  assert.equal(focused.code, 0, `published dist-tests focused test failed while build skipped (${focused.signal || focused.code}):\n${focused.output}`);
});

test("same-target build:node calls serialize and publish complete runtime", async () => {
  const isolatedRoot = await makeIsolatedSource("cpb-parallel-build-node");
  const [first, second] = await Promise.all([
    runNpmScript(isolatedRoot, "build:node"),
    runNpmScript(isolatedRoot, "build:node"),
  ]);

  assert.equal(first.code, 0, `first build:node failed (${first.signal || first.code}):\n${first.output}`);
  assert.equal(second.code, 0, `second build:node failed (${second.signal || second.code}):\n${second.output}`);
  assert.match(await readFile(path.join(isolatedRoot, "dist", ".cpb-build.json"), "utf8"), /"target": "node"/);
  assert.match(await readFile(path.join(isolatedRoot, "dist", "package.json"), "utf8"), /"name": "codepatchbay"/);
  assert.deepEqual((await readJson(path.join(isolatedRoot, "dist", "package.json"))).bin, { cpb: "cpb" });
  await assert.rejects(
    access(path.join(isolatedRoot, "dist", "server", "services", "test-acp-agent.js")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("failed staged build preserves the last successful output", async () => {
  const isolatedRoot = await makeIsolatedSource("cpb-build-failure-preserves-output");
  const initial = await runNpmScript(isolatedRoot, "build:tests");
  assert.equal(initial.code, 0, `initial build:tests failed (${initial.signal || initial.code}):\n${initial.output}`);
  const sentinel = path.join(isolatedRoot, "dist-tests", "old-sentinel.txt");
  await writeFile(sentinel, "old output survives\n", "utf8");
  await writeFile(path.join(isolatedRoot, "tests", "intentional-build-failure.test.ts"), "const = ;\n", "utf8");

  const failed = await runNpmScript(isolatedRoot, "build:tests");
  assert.notEqual(failed.code, 0, "broken TypeScript should fail the staged build");
  assert.equal(await readFile(sentinel, "utf8"), "old output survives\n");
});

test("an injected owner write failure removes only its incomplete lock", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-owner-write-failure");
  const lockRoot = await tempRoot("cpb-owner-write-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "owner-write",
  });

  assert.notEqual(failed.code, 0, "the injected owner write failure must fail the build");
  assert.match(failed.output, /owner-write.*EIO/);
  await assert.rejects(access(lockDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual((await readdir(lockRoot)).filter((entry) => entry.includes(".quarantine-")), []);

  const recovered = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(recovered.code, 0, `build did not recover after owner write failure:\n${recovered.output}`);
  assert.deepEqual(await transactionArtifacts(isolatedRoot, "dist-tests"), []);
});

test("owner temporary-file removal fsyncs its parent and reports cleanup failure", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-owner-temp-cleanup-fsync");
  const lockRoot = await tempRoot("cpb-owner-temp-cleanup-fsync-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "owner-temp-before-rename,owner-temp-remove-parent-fsync",
  });

  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /owner-temp-before-rename/);
  assert.match(failed.output, /owner-temp-remove-parent-fsync/);
  assert.match(failed.output, /recoveryPaths:/);
  await assert.rejects(access(lockDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("unsupported directory fsync fails closed instead of being reported durable", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-directory-fsync-unsupported");
  const lockRoot = await tempRoot("cpb-directory-fsync-unsupported-locks");

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "directory-fsync-unsupported",
  });

  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /directory-fsync-unsupported.*ENOTSUP/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /recoveryPaths:/);
});

test("build lock owner post-rename fsync failure is reported as committed ambiguity", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-owner-fsync-ambiguity");
  const lockRoot = await tempRoot("cpb-owner-fsync-ambiguity-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  const leaseDir = `${lockDir}.acquire`;

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "owner-parent-fsync",
  });
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /lock_owner_committed_durability_ambiguous/);
  assert.equal(await access(path.join(leaseDir, "owner.json")).then(() => true, () => false), true);

  const recovered = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(recovered.code, 0, `build did not recover committed owner ambiguity:\n${recovered.output}`);
});

test("build lock post-remove fsync failure is reported as committed ambiguity", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-lock-remove-fsync-ambiguity");
  const lockRoot = await tempRoot("cpb-lock-remove-fsync-ambiguity-locks");

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "lock-remove-parent-fsync",
  });
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /lock_removal_committed_durability_ambiguous/);

  const recovered = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(recovered.code, 0, `build did not recover committed removal ambiguity:\n${recovered.output}`);
});

test("a live old lock owner is never evicted by stale-age or invalid numeric settings", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-live-old-build-lock");
  const lockRoot = await tempRoot("cpb-live-old-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  const token = "live-old-owner";
  await writeSyntheticLock(lockDir, {
    token,
    pid: process.pid,
    repoRoot: isolatedRoot,
    createdAt: "2000-01-01T00:00:00.000Z",
  });

  for (const invalidStaleMs of ["-1", "NaN"]) {
    const blocked = await runNpmScript(isolatedRoot, "build:tests", {
      CPB_BUILD_LOCK_ROOT: lockRoot,
      CPB_BUILD_LOCK_STALE_MS: invalidStaleMs,
      CPB_BUILD_LOCK_WAIT_MS: "75",
    });
    assert.notEqual(blocked.code, 0, `live owner was unexpectedly evicted for ${invalidStaleMs}`);
    assert.match(blocked.output, /timed out waiting for build:tests lock/);
    assert.equal((await readJson(path.join(lockDir, "owner.json"))).token, token);
  }
});

test("new build locks persist exact canonical process identity", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-lock-current-identity");
  const lockRoot = await tempRoot("cpb-build-lock-current-identity-locks");
  const hookRoot = await tempRoot("cpb-build-lock-current-identity-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-build",
  });
  await waitForPath(path.join(hookRoot, "after-build.ready"));

  const owner = await readJson(path.join(lockDir, "owner.json"));
  assert.equal(owner.processIdentity.pid, owner.pid);
  assert.equal(owner.processIdentity.birthIdPrecision, "exact");
  assert.equal(owner.processIdentity.incarnation, `${owner.pid}:${owner.processIdentity.birthId}`);
  assert.equal(Number.isFinite(Date.parse(owner.processIdentity.capturedAt)), true);
  if (owner.processIdentity.processGroupId !== undefined) {
    assert.equal(Number.isInteger(owner.processIdentity.processGroupId), true);
    assert.ok(owner.processIdentity.processGroupId > 0);
  }

  await writeFile(path.join(hookRoot, "after-build.continue"), "continue\n", "utf8");
  const result = await build;
  assert.equal(result.code, 0, `build failed after identity inspection:\n${result.output}`);
});

test("coarse, missing, or malformed persisted lock identities fail closed", async () => {
  const cases = [
    {
      name: "missing-precision",
      processIdentity: {
        pid: 99_999_991,
        birthId: "legacy-generation",
        incarnation: "99999991:legacy-generation",
        capturedAt: new Date().toISOString(),
      },
    },
    {
      name: "coarse",
      processIdentity: {
        pid: 99_999_992,
        birthId: "ps-lstart:Tue Jul 21 12:34:56 2026",
        incarnation: "99999992:ps-lstart:Tue Jul 21 12:34:56 2026",
        capturedAt: new Date().toISOString(),
        birthIdPrecision: "coarse" as const,
      },
    },
    {
      name: "malformed-captured-at",
      processIdentity: {
        pid: 99_999_993,
        birthId: "malformed-generation",
        incarnation: "99999993:malformed-generation",
        capturedAt: "not-a-date",
        birthIdPrecision: "exact" as const,
      },
    },
    {
      name: "noncanonical-captured-at",
      processIdentity: {
        pid: 99_999_994,
        birthId: "noncanonical-time-generation",
        incarnation: "99999994:noncanonical-time-generation",
        capturedAt: "2026-01-01T00:00:00Z",
        birthIdPrecision: "exact" as const,
      },
    },
    {
      name: "unsafe-pid",
      processIdentity: {
        pid: Number.MAX_SAFE_INTEGER + 1,
        birthId: "unsafe-pid-generation",
        incarnation: `${Number.MAX_SAFE_INTEGER + 1}:unsafe-pid-generation`,
        capturedAt: new Date().toISOString(),
        birthIdPrecision: "exact" as const,
      },
    },
    {
      name: "unsafe-process-group",
      processIdentity: {
        pid: 99_999_995,
        birthId: "unsafe-process-group-generation",
        incarnation: "99999995:unsafe-process-group-generation",
        capturedAt: new Date().toISOString(),
        birthIdPrecision: "exact" as const,
        processGroupId: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ];

  for (const testCase of cases) {
    const isolatedRoot = await makeMinimalBuildSource(`cpb-build-lock-${testCase.name}`);
    const lockRoot = await tempRoot(`cpb-build-lock-${testCase.name}-locks`);
    const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
    await writeSyntheticLock(lockDir, {
      token: testCase.name,
      pid: testCase.processIdentity.pid,
      repoRoot: isolatedRoot,
      createdAt: "2000-01-01T00:00:00.000Z",
      processIdentity: testCase.processIdentity,
    });

    const blocked = await runNpmScript(isolatedRoot, "build:tests", {
      CPB_BUILD_LOCK_ROOT: lockRoot,
      CPB_BUILD_LOCK_WAIT_MS: "75",
    });
    assert.notEqual(blocked.code, 0, `${testCase.name} owner was unexpectedly evicted`);
    assert.match(blocked.output, /timed out waiting for build:tests lock/);
    assert.equal((await readJson(path.join(lockDir, "owner.json"))).token, testCase.name);
  }
});

test("build-output rejects symbolic-link lock paths without touching their targets", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-lock-symlink");
  const lockRoot = await tempRoot("cpb-build-lock-symlink-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  const target = await tempRoot("cpb-build-lock-symlink-target");
  await writeFile(path.join(target, "sentinel.txt"), "preserve me", "utf8");
  await mkdir(path.dirname(lockDir), { recursive: true });
  await symlink(target, lockDir, "dir");

  const blocked = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "75",
  });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.output, /unsafe build lock directory/);
  assert.equal(await readFile(path.join(target, "sentinel.txt"), "utf8"), "preserve me");
});

test("build-output rejects a symbolic-link owner file without following it", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-owner-symlink");
  const lockRoot = await tempRoot("cpb-build-owner-symlink-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "symlink-owner",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });
  const externalOwner = path.join(lockRoot, "external-owner.json");
  await writeFile(externalOwner, "{\"external\":true}\n", "utf8");
  await rm(path.join(lockDir, "owner.json"));
  await symlink(externalOwner, path.join(lockDir, "owner.json"));

  const blocked = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "75",
  });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.output, /unsafe build lock owner file/);
  assert.equal(await readFile(externalOwner, "utf8"), "{\"external\":true}\n");
});

test("build-output rejects an owner path replaced after reading from the pinned descriptor", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-owner-post-read-replacement");
  const lockRoot = await tempRoot("cpb-build-owner-post-read-replacement-locks");
  const hookRoot = await tempRoot("cpb-build-owner-post-read-replacement-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "dead-owner-replaced-after-read",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });
  const ownerFile = path.join(lockDir, "owner.json");
  const replacement = path.join(lockRoot, "replacement-owner.json");
  await writeFile(replacement, await readFile(ownerFile));

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-owner-read",
  });
  await waitForPath(path.join(hookRoot, "after-owner-read.ready"));
  await rename(replacement, ownerFile);
  await writeFile(path.join(hookRoot, "after-owner-read.continue"), "continue\n", "utf8");

  const blocked = await build;
  assert.notEqual(blocked.code, 0, "an owner pathname replacement must fail closed");
  assert.match(blocked.output, /build lock owner path changed while reading/);
  assert.equal((await readJson(ownerFile)).token, "dead-owner-replaced-after-read");
});

test("build-output detects a same-size in-place owner rewrite even when mtime is restored", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-owner-ctime-rewrite");
  const lockRoot = await tempRoot("cpb-build-owner-ctime-rewrite-locks");
  const hookRoot = await tempRoot("cpb-build-owner-ctime-rewrite-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "ctime-old-owner",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });
  const ownerFile = path.join(lockDir, "owner.json");
  const original = await readFile(ownerFile, "utf8");
  const originalInfo = await stat(ownerFile);
  const replacement = original.replaceAll("ctime-old-owner", "ctime-new-owner");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-owner-read",
  });
  await waitForPath(path.join(hookRoot, "after-owner-read.ready"));
  await writeFile(ownerFile, replacement, "utf8");
  await utimes(ownerFile, originalInfo.atime, originalInfo.mtime);
  await writeFile(path.join(hookRoot, "after-owner-read.continue"), "continue\n", "utf8");

  const blocked = await build;
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.output, /build lock owner (path )?changed while reading/);
  assert.equal((await readJson(ownerFile)).token, "ctime-new-owner");
});

test("build-output requires O_NOFOLLOW instead of silently opening owner files without it", async () => {
  const script = await readFile(path.resolve(import.meta.dirname, "..", "..", "scripts", "build-output.mjs"), "utf8");
  assert.match(script, /O_NOFOLLOW is unavailable; refusing build lock owner read/);
  assert.doesNotMatch(script, /constants\.O_NOFOLLOW\s*\|\|\s*0/);
});

test("build-output bounds owner reads even when the opened file grows after fstat", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-owner-growth-bound");
  const lockRoot = await tempRoot("cpb-build-owner-growth-bound-locks");
  const hookRoot = await tempRoot("cpb-build-owner-growth-bound-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "owner-grown-after-open",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });
  const ownerFile = path.join(lockDir, "owner.json");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-owner-open",
  });
  await waitForPath(path.join(hookRoot, "after-owner-open.ready"));
  await writeFile(ownerFile, Buffer.alloc(64 * 1024 + 1, 0x20));
  await writeFile(path.join(hookRoot, "after-owner-open.continue"), "continue\n", "utf8");

  const blocked = await build;
  assert.notEqual(blocked.code, 0, "a growing owner file must fail closed");
  assert.match(blocked.output, /build lock owner exceeds 65536 bytes/);
});

test("build-output rejects a statically oversized owner before opening it", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-owner-oversized");
  const lockRoot = await tempRoot("cpb-build-owner-oversized-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "oversized-owner",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });
  await writeFile(path.join(lockDir, "owner.json"), Buffer.alloc(64 * 1024 + 1, 0x20));

  const blocked = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "75",
  });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.output, /unsafe build lock owner file/);
});

test("build-output macOS identity contract uses proc_pidinfo and treats ps lstart as coarse", async () => {
  const script = await readFile(path.resolve(import.meta.dirname, "..", "..", "scripts", "build-output.mjs"), "utf8");
  assert.match(script, /spawnSync\("\/usr\/bin\/python3"/);
  assert.match(script, /proc_pidinfo/);
  assert.match(script, /darwin-proc-pidinfo-starttime/);
  assert.match(script, /birthIdPrecision !== "exact"/);
  assert.equal(script.includes("`ps-lstart:${started}`, \"coarse\""), true);
});

test("build-output process fence skips an unrelated listener on its first candidate port", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-fence-unrelated");
  const lockRoot = await tempRoot("cpb-build-fence-unrelated-locks");
  const { firstPort } = await buildFenceDescriptor(isolatedRoot);
  const unrelated = await listenForBuildFenceTest(firstPort, "unrelated-listener\n");
  try {
    const built = await runNpmScript(isolatedRoot, "build:tests", {
      CPB_BUILD_LOCK_ROOT: lockRoot,
      CPB_BUILD_LOCK_WAIT_MS: "5000",
    });
    assert.equal(built.code, 0, built.output);
  } finally {
    await closeBuildFenceTestServer(unrelated);
  }
});

test("build-output process fence fails closed when the same key is already held", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-fence-same-key");
  const lockRoot = await tempRoot("cpb-build-fence-same-key-locks");
  const { firstPort, key, protocol } = await buildFenceDescriptor(isolatedRoot);
  const holder = await listenForBuildFenceTest(firstPort, `${protocol}${key}\n`);
  try {
    const blocked = await runNpmScript(isolatedRoot, "build:tests", {
      CPB_BUILD_LOCK_ROOT: lockRoot,
      CPB_BUILD_LOCK_WAIT_MS: "75",
    });
    assert.notEqual(blocked.code, 0, "same-key process fence must block a competing build");
    assert.match(blocked.output, /timed out waiting for build:tests process fence/);
  } finally {
    await closeBuildFenceTestServer(holder);
  }
});

test("stale-lock ABA recovery quarantines and preserves the successor owner for explicit recovery", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-lock-aba");
  const lockRoot = await tempRoot("cpb-aba-locks");
  const hookRoot = await tempRoot("cpb-aba-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "dead-predecessor",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "500",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-lock-quarantine",
  });
  await waitForPath(path.join(hookRoot, "before-lock-quarantine.ready"));

  await rm(lockDir, { recursive: true, force: true });
  await writeSyntheticLock(lockDir, {
    token: "live-successor",
    pid: process.pid,
    repoRoot: isolatedRoot,
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  await writeFile(path.join(hookRoot, "before-lock-quarantine.continue"), "continue\n", "utf8");

  const blocked = await build;
  assert.notEqual(blocked.code, 0, "the successor lock should keep the build blocked");
  assert.match(blocked.output, /automatic canonical reconstruction refused/);
  assert.match(blocked.output, /publicationState:lock_quarantined_recovery_required/);
  assert.match(blocked.output, /committed:true/);
  assert.match(blocked.output, /recoveryPaths:/);
  await assert.rejects(access(lockDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const quarantine = (await readdir(lockRoot)).find((entry) => entry.includes(".quarantine-"));
  assert.ok(quarantine);
  assert.equal((await readJson(path.join(lockRoot, quarantine, "owner.json"))).token, "live-successor");
  assert.deepEqual(
    (await readdir(path.join(lockRoot, quarantine))).filter((entry) => entry.startsWith(".owner-")),
    [".owner-live-successor"],
  );
});

test("an injected publish EXDEV quarantines the last successful output for explicit recovery", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-exdev");
  const lockRoot = await tempRoot("cpb-publish-exdev-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  const sentinel = path.join(isolatedRoot, "dist-tests", "last-successful.txt");
  const metadataPath = path.join(isolatedRoot, "dist-tests", ".cpb-build.json");
  const oldMetadata = await readFile(metadataPath, "utf8");
  await writeFile(sentinel, "preserve me\n", "utf8");
  await writeFile(path.join(isolatedRoot, "tests", "publish-exdev-trigger.ts"), "export const publishExdevTrigger = true;\n", "utf8");

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "publish-stage-rename",
  });

  assert.notEqual(failed.code, 0, "the injected EXDEV must fail publication");
  assert.match(failed.output, /publish-stage-rename.*EXDEV/);
  assert.match(failed.output, /automatic backup restore refused/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /publicationState:backup_quarantined_recovery_required/);
  assert.match(failed.output, /recoveryPaths:/);
  await assert.rejects(access(path.join(isolatedRoot, "dist-tests")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const backup = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-backup-"));
  assert.ok(backup, "the prior generation must remain quarantined for recovery");
  assert.equal(await readFile(path.join(path.dirname(isolatedRoot), backup, "last-successful.txt"), "utf8"), "preserve me\n");
  assert.equal(await readFile(path.join(path.dirname(isolatedRoot), backup, ".cpb-build.json"), "utf8"), oldMetadata);
});

test("publish commit never overwrites an empty successor appearing after the old output is moved", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-successor-commit-race");
  const lockRoot = await tempRoot("cpb-publish-successor-commit-race-locks");
  const hookRoot = await tempRoot("cpb-publish-successor-commit-race-hooks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(path.join(isolatedRoot, "dist-tests", "publish-race-sentinel.txt"), "preserve old output\n", "utf8");
  await writeFile(
    path.join(isolatedRoot, "tests", "publish-successor-commit-race.ts"),
    "export const publishSuccessorCommitRace = true;\n",
    "utf8",
  );

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-publish-stage-commit",
  });
  await waitForPath(path.join(hookRoot, "before-publish-stage-commit.ready"));
  const outputPath = path.join(isolatedRoot, "dist-tests");
  await mkdir(outputPath);
  await writeFile(path.join(hookRoot, "before-publish-stage-commit.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /successor output preserved/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /recoveryPaths:/);
  assert.deepEqual(await readdir(outputPath), [], "publish overwrote an empty successor generation");
  const backup = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-backup-"));
  assert.ok(backup, "the previous output must remain recoverable after publish loses the commit race");
  assert.equal(
    await readFile(path.join(path.dirname(isolatedRoot), backup, "publish-race-sentinel.txt"), "utf8"),
    "preserve old output\n",
  );
});

test("publish refuses a replacement of its pinned canonical reservation", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-reservation-aba");
  const lockRoot = await tempRoot("cpb-publish-reservation-aba-locks");
  const hookRoot = await tempRoot("cpb-publish-reservation-aba-hooks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(path.join(isolatedRoot, "dist-tests", "publish-reservation-sentinel.txt"), "preserve backup\n", "utf8");
  await writeFile(
    path.join(isolatedRoot, "tests", "publish-reservation-aba.ts"),
    "export const publishReservationAba = true;\n",
    "utf8",
  );

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-publish-stage-reservation",
  });
  await waitForPath(path.join(hookRoot, "after-publish-stage-reservation.ready"));
  const outputPath = path.join(isolatedRoot, "dist-tests");
  const displacedReservation = path.join(isolatedRoot, "displaced-publish-reservation");
  await rename(outputPath, displacedReservation);
  await mkdir(outputPath);
  await writeFile(path.join(hookRoot, "after-publish-stage-reservation.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /publish reservation generation changed/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /recoveryPaths:/);
  assert.deepEqual(await readdir(outputPath), [], "replacement successor received staged entries");
  const backup = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-backup-"));
  assert.ok(backup);
  assert.equal(
    await readFile(path.join(path.dirname(isolatedRoot), backup, "publish-reservation-sentinel.txt"), "utf8"),
    "preserve backup\n",
  );
});

test("partial publish fsyncs both modified directories and reports committed recovery", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-partial-fsync");
  const lockRoot = await tempRoot("cpb-publish-partial-fsync-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(path.join(isolatedRoot, "dist-tests", "publish-partial-sentinel.txt"), "recover old output\n", "utf8");
  await writeFile(
    path.join(isolatedRoot, "tests", "publish-partial-fsync.ts"),
    "export const publishPartialFsync = true;\n",
    "utf8",
  );

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: [
      "publish-stage-entry-after-first",
      "publish-partial-destination-fsync",
      "publish-partial-source-fsync",
    ].join(","),
  });

  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /publish-stage-entry-after-first/);
  assert.match(failed.output, /publish-partial-destination-fsync/);
  assert.match(failed.output, /publish-partial-source-fsync/);
  assert.match(failed.output, /publicationState:publish_no_clobber_incomplete/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /recoveryPaths:/);
  const artifacts = await transactionArtifacts(isolatedRoot, "dist-tests");
  assert.equal(artifacts.some((entry) => entry.includes(".cpb-backup-")), true);
  assert.equal(await access(path.join(isolatedRoot, "dist-tests")).then(() => true, () => false), true);
});

test("durably published output identity failure reports committed publication ambiguity", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-published-identity-ambiguity");
  const lockRoot = await tempRoot("cpb-published-identity-ambiguity-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(
    path.join(isolatedRoot, "tests", "published-identity-ambiguity.ts"),
    "export const publishedIdentityAmbiguity = true;\n",
    "utf8",
  );

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "published-identity-stat",
  });

  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /publicationState:publish_committed_identity_ambiguous/);
  assert.match(failed.output, /recoveryPaths:/);
  assert.match(
    await readFile(path.join(isolatedRoot, "dist-tests", "tests", "published-identity-ambiguity.js"), "utf8"),
    /true/,
  );
  assert.equal(
    (await transactionArtifacts(isolatedRoot, "dist-tests")).some((entry) => entry.includes(".cpb-backup-")),
    true,
    "the old generation backup must be retained while publication identity is ambiguous",
  );
});

test("every post-publish directory fsync failure reports committed publication ambiguity", async () => {
  for (const fault of [
    "publish-output-parent-fsync",
    "publish-backup-parent-fsync",
    "publish-staging-parent-fsync",
  ]) {
    const isolatedRoot = await makeMinimalBuildSource(`cpb-publish-fsync-${fault}`);
    const lockRoot = await tempRoot(`cpb-publish-fsync-${fault}-locks`);
    const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
    assert.equal(initial.code, 0, `initial build failed for ${fault}:\n${initial.output}`);
    const probe = path.join(isolatedRoot, "tests", `${fault}.ts`);
    await writeFile(probe, `export const publishFsyncFault = ${JSON.stringify(fault)};\n`, "utf8");

    const failed = await runNpmScript(isolatedRoot, "build:tests", {
      CPB_BUILD_LOCK_ROOT: lockRoot,
      CPB_BUILD_TEST_FAULTS: fault,
    });

    assert.notEqual(failed.code, 0, `${fault} must not be reported as a durable publish`);
    assert.match(failed.output, /committed:true/);
    assert.match(failed.output, /publicationState:publish_committed_durability_ambiguous/);
    assert.match(failed.output, /recoveryPaths:/);
    assert.match(await readFile(path.join(isolatedRoot, "dist-tests", "tests", `${fault}.js`), "utf8"), new RegExp(fault));
    assert.equal(
      (await transactionArtifacts(isolatedRoot, "dist-tests")).some((entry) => entry.includes(".cpb-backup-")),
      true,
      `${fault} removed the recovery backup`,
    );
  }
});

test("an unrestored old-output rename is reported as committed backup ambiguity", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-unrestored-backup-ambiguity");
  const lockRoot = await tempRoot("cpb-publish-unrestored-backup-ambiguity-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(path.join(isolatedRoot, "dist-tests", "unrestored-sentinel.txt"), "recover from backup\n", "utf8");
  await writeFile(
    path.join(isolatedRoot, "tests", "unrestored-backup-trigger.ts"),
    "export const unrestoredBackupTrigger = true;\n",
    "utf8",
  );

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "publish-stage-rename,failed-publish-backup-parent-fsync",
  });

  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /publicationState:backup_quarantine_committed_durability_ambiguous/);
  assert.match(failed.output, /recoveryPaths:/);
  const backup = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-backup-"));
  assert.ok(backup);
  assert.equal(
    await readFile(path.join(path.dirname(isolatedRoot), backup, "unrestored-sentinel.txt"), "utf8"),
    "recover from backup\n",
  );
});

test("source mutation discards staging and publishes only a stable retry", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-source-mutation");
  const lockRoot = await tempRoot("cpb-source-mutation-locks");
  const hookRoot = await tempRoot("cpb-source-mutation-hooks");
  const probeSource = path.join(isolatedRoot, "tests", "build-mutation-probe.ts");
  await writeFile(probeSource, "export const buildMutationProbe = \"before\";\n", "utf8");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-build",
  });
  await waitForPath(path.join(hookRoot, "after-build.ready"));

  const staged = await transactionArtifacts(isolatedRoot, "dist-tests");
  assert.equal(staged.length, 1, `expected one same-filesystem staging root, found ${staged.join(", ")}`);
  assert.equal(
    String((await stat(path.join(path.dirname(isolatedRoot), staged[0]))).dev),
    String((await stat(isolatedRoot)).dev),
  );
  await writeFile(probeSource, "export const buildMutationProbe = \"after\";\n", "utf8");
  await writeFile(path.join(hookRoot, "after-build.continue"), "continue\n", "utf8");

  const result = await build;
  assert.equal(result.code, 0, `stable retry did not publish:\n${result.output}`);
  assert.match(result.output, /source changed during build:tests; discarding staging output and retrying/);
  assert.match(
    await readFile(path.join(isolatedRoot, "dist-tests", "tests", "build-mutation-probe.js"), "utf8"),
    /after/,
  );
  assert.deepEqual(await transactionArtifacts(isolatedRoot, "dist-tests"), []);
});

test("build-output staging cleanup preserves a successor installed at the final removal boundary", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-staging-cleanup-successor");
  const lockRoot = await tempRoot("cpb-staging-cleanup-successor-locks");
  const hookRoot = await tempRoot("cpb-staging-cleanup-successor-hooks");
  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-staging-cleanup-final-remove",
  });
  await waitForPath(path.join(hookRoot, "before-staging-cleanup-final-remove.ready"));
  const parent = path.dirname(isolatedRoot);
  const cleanupName = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-cleanup-"));
  assert.ok(cleanupName, "expected the no-clobber staging cleanup container");
  const cleanupContainer = path.join(parent, cleanupName);
  const [isolatedName] = await readdir(cleanupContainer);
  const isolatedPath = path.join(cleanupContainer, isolatedName);
  const predecessorPath = `${isolatedPath}.owned-predecessor`;
  await rename(isolatedPath, predecessorPath);
  await mkdir(isolatedPath);
  await writeFile(path.join(isolatedPath, "successor.txt"), "preserve staging cleanup successor\n", "utf8");
  await writeFile(path.join(hookRoot, "before-staging-cleanup-final-remove.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /isolated generation changed before final removal/);
  assert.equal(
    await readFile(path.join(isolatedPath, "successor.txt"), "utf8"),
    "preserve staging cleanup successor\n",
  );
  assert.equal(await access(predecessorPath).then(() => true, () => false), true);
  assert.equal(await access(path.join(isolatedRoot, "dist-tests")).then(() => true, () => false), true);
});

test("build-output reports backup primary failure and hostile staging cleanup together", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-cleanup-dual-failure");
  const lockRoot = await tempRoot("cpb-build-cleanup-dual-failure-locks");
  const hookRoot = await tempRoot("cpb-build-cleanup-dual-failure-hooks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(
    path.join(isolatedRoot, "tests", "cleanup-dual-failure.ts"),
    "export const cleanupDualFailure = true;\n",
    "utf8",
  );
  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "cleanup-backup",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-staging-cleanup-final-remove",
  });
  await waitForPath(path.join(hookRoot, "before-staging-cleanup-final-remove.ready"));
  const parent = path.dirname(isolatedRoot);
  const cleanupName = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-cleanup-"));
  assert.ok(cleanupName);
  const cleanupContainer = path.join(parent, cleanupName);
  const [isolatedName] = await readdir(cleanupContainer);
  const isolatedPath = path.join(cleanupContainer, isolatedName);
  await rename(isolatedPath, `${isolatedPath}.owned-predecessor`);
  await mkdir(isolatedPath);
  await writeFile(path.join(isolatedPath, "successor.txt"), "dual failure successor\n", "utf8");
  await writeFile(path.join(hookRoot, "before-staging-cleanup-final-remove.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /cleanup-backup/);
  assert.match(failed.output, /isolated generation changed before final removal/);
  assert.ok(
    failed.output.indexOf("cleanup-backup") < failed.output.indexOf("isolated generation changed before final removal"),
    `primary and cleanup truth were reordered:\n${failed.output}`,
  );
  assert.equal(await readFile(path.join(isolatedPath, "successor.txt"), "utf8"), "dual failure successor\n");
});

test("build-output backup cleanup preserves a successor installed at the final removal boundary", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-backup-cleanup-successor");
  const lockRoot = await tempRoot("cpb-backup-cleanup-successor-locks");
  const hookRoot = await tempRoot("cpb-backup-cleanup-successor-hooks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(
    path.join(isolatedRoot, "tests", "backup-cleanup-successor.ts"),
    "export const backupCleanupSuccessor = true;\n",
    "utf8",
  );
  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-backup-cleanup-final-remove",
  });
  await waitForPath(path.join(hookRoot, "before-backup-cleanup-final-remove.ready"));
  const parent = path.dirname(isolatedRoot);
  const cleanupName = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-cleanup-"));
  assert.ok(cleanupName);
  const cleanupContainer = path.join(parent, cleanupName);
  const [isolatedName] = await readdir(cleanupContainer);
  const isolatedPath = path.join(cleanupContainer, isolatedName);
  const predecessorPath = `${isolatedPath}.owned-predecessor`;
  await rename(isolatedPath, predecessorPath);
  await mkdir(isolatedPath);
  await writeFile(path.join(isolatedPath, "successor.txt"), "preserve backup cleanup successor\n", "utf8");
  await writeFile(path.join(hookRoot, "before-backup-cleanup-final-remove.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /isolated generation changed before final removal/);
  assert.equal(
    await readFile(path.join(isolatedPath, "successor.txt"), "utf8"),
    "preserve backup cleanup successor\n",
  );
  assert.equal(await access(predecessorPath).then(() => true, () => false), true);
});

test("changed-source builds keep the old output visible until the no-clobber publish window", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-visibility");
  const lockRoot = await tempRoot("cpb-publish-visibility-locks");
  const hookRoot = await tempRoot("cpb-publish-visibility-hooks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  const sentinel = path.join(isolatedRoot, "dist-tests", "visible-old-output.txt");
  const metadataPath = path.join(isolatedRoot, "dist-tests", ".cpb-build.json");
  const oldMetadata = await readFile(metadataPath, "utf8");
  await writeFile(sentinel, "visible until commit\n", "utf8");
  await writeFile(path.join(isolatedRoot, "tests", "publish-visibility-trigger.ts"), "export const publishVisibilityTrigger = true;\n", "utf8");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-publish",
  });
  await waitForPath(path.join(hookRoot, "before-publish.ready"));

  assert.equal(await readFile(sentinel, "utf8"), "visible until commit\n");
  assert.equal(await readFile(metadataPath, "utf8"), oldMetadata);
  const buildScript = await readFile(path.join(isolatedRoot, "scripts", "build-output.mjs"), "utf8");
  assert.doesNotMatch(
    buildScript,
    /renameSync\(stagingOutput, outputPath\)/,
    "publish must not use an overwrite-capable directory rename",
  );
  assert.match(
    buildScript,
    /publishDirectoryNoClobber\(stagingOutput, outputPath/,
    "publish must reserve the canonical output with the no-clobber commit primitive",
  );
  await writeFile(path.join(hookRoot, "before-publish.continue"), "continue\n", "utf8");

  const result = await build;
  assert.equal(result.code, 0, `changed-source publish failed:\n${result.output}`);
  await assert.rejects(readFile(sentinel, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.match(await readFile(path.join(isolatedRoot, "dist-tests", "tests", "publish-visibility-trigger.js"), "utf8"), /true/);
  assert.deepEqual(await transactionArtifacts(isolatedRoot, "dist-tests"), []);
});

test("post-publish cleanup failures are all attempted and report an explicit committed recovery state", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-committed-cleanup-state");
  const lockRoot = await tempRoot("cpb-committed-cleanup-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(
    path.join(isolatedRoot, "tests", "committed-cleanup-probe.ts"),
    "export const committedCleanupProbe = true;\n",
    "utf8",
  );

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "cleanup-backup,cleanup-staging,cleanup-lock",
  });

  assert.notEqual(failed.code, 0, "post-publish cleanup failures must return a non-zero CLI status");
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /publicationState:committed_cleanup_failed/);
  for (const fault of ["cleanup-backup", "cleanup-staging", "cleanup-lock"]) {
    assert.match(failed.output, new RegExp(fault), `${fault} was not attempted or reported`);
  }
  assert.ok(
    failed.output.indexOf("cleanup-backup") < failed.output.indexOf("cleanup-staging")
      && failed.output.indexOf("cleanup-staging") < failed.output.indexOf("cleanup-lock"),
    `cleanup errors did not preserve primary-first order:\n${failed.output}`,
  );
  assert.match(failed.output, /recoveryPaths:/);
  assert.match(
    await readFile(path.join(isolatedRoot, "dist-tests", "tests", "committed-cleanup-probe.js"), "utf8"),
    /true/,
  );

  const transactionResidue = await transactionArtifacts(isolatedRoot, "dist-tests");
  assert.equal(transactionResidue.some((entry) => entry.includes(".cpb-backup-")), true);
  assert.equal(transactionResidue.some((entry) => entry.includes(".cpb-stage-")), true);
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  assert.equal(await access(lockDir).then(() => true, () => false), true, "failed lock cleanup must preserve its recovery path");

  const recovered = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(recovered.code, 0, `stale committed-cleanup lock did not recover:\n${recovered.output}`);
  await assert.rejects(access(lockDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("backup removal parent fsync failure reports committed cleanup ambiguity", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-backup-remove-fsync-ambiguity");
  const lockRoot = await tempRoot("cpb-backup-remove-fsync-ambiguity-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(
    path.join(isolatedRoot, "tests", "backup-remove-fsync-probe.ts"),
    "export const backupRemoveFsyncProbe = true;\n",
    "utf8",
  );

  const failed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "cleanup-backup-parent-fsync",
  });

  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /publicationState:committed_cleanup_durability_ambiguous/);
  assert.match(failed.output, /recoveryPaths:/);
  assert.match(
    await readFile(path.join(isolatedRoot, "dist-tests", "tests", "backup-remove-fsync-probe.js"), "utf8"),
    /true/,
  );
  assert.equal(
    (await transactionArtifacts(isolatedRoot, "dist-tests")).some((entry) => entry.includes(".cpb-backup-")),
    false,
    "the backup unlink committed before its parent fsync failed",
  );
});

test("a source mutation after publish quarantines both generations instead of reconstructing canonical output", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-post-publish-fingerprint");
  const lockRoot = await tempRoot("cpb-post-publish-fingerprint-locks");
  const hookRoot = await tempRoot("cpb-post-publish-fingerprint-hooks");
  const probeSource = path.join(isolatedRoot, "tests", "post-publish-probe.ts");
  await writeFile(probeSource, "export const postPublishProbe = \"initial\";\n", "utf8");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(probeSource, "export const postPublishProbe = \"candidate\";\n", "utf8");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-publish-before-fingerprint",
  });
  await waitForPath(path.join(hookRoot, "after-publish-before-fingerprint.ready"));
  assert.equal(
    (await transactionArtifacts(isolatedRoot, "dist-tests")).some((entry) => entry.includes(".cpb-backup-")),
    true,
    "the old output backup must remain until the post-publish fingerprint is stable",
  );
  await writeFile(probeSource, "export const postPublishProbe = \"stable\";\n", "utf8");
  await writeFile(path.join(hookRoot, "after-publish-before-fingerprint.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /published output quarantined; manual recovery required/);
  assert.match(failed.output, /publicationState:rollback_quarantined_recovery_required/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /recoveryPaths:/);
  await assert.rejects(access(path.join(isolatedRoot, "dist-tests")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const artifacts = await transactionArtifacts(isolatedRoot, "dist-tests");
  const backup = artifacts.find((entry) => entry.includes(".cpb-backup-"));
  const rejected = artifacts.find((entry) => entry.includes(".cpb-rollback-"));
  assert.ok(backup);
  assert.ok(rejected);
  assert.match(
    await readFile(path.join(path.dirname(isolatedRoot), rejected, "tests", "post-publish-probe.js"), "utf8"),
    /candidate/,
  );
});

test("rollback quarantine fsync failures preserve both recovery generations and report ambiguity", async () => {
  const cases = [
    {
      fault: "rollback-output-parent-fsync",
      publicationState: "rollback_isolation_committed_durability_ambiguous",
    },
    {
      fault: "rollback-rejected-parent-fsync",
      publicationState: "rollback_isolation_committed_durability_ambiguous",
    },
  ];

  for (const testCase of cases) {
    const isolatedRoot = await makeMinimalBuildSource(`cpb-${testCase.fault}`);
    const lockRoot = await tempRoot(`cpb-${testCase.fault}-locks`);
    const hookRoot = await tempRoot(`cpb-${testCase.fault}-hooks`);
    const probeSource = path.join(isolatedRoot, "tests", "rollback-durability-probe.ts");
    await writeFile(probeSource, "export const rollbackDurabilityProbe = \"initial\";\n", "utf8");
    const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
    assert.equal(initial.code, 0, `initial build failed for ${testCase.fault}:\n${initial.output}`);
    await writeFile(probeSource, "export const rollbackDurabilityProbe = \"candidate\";\n", "utf8");

    const build = runNpmScript(isolatedRoot, "build:tests", {
      CPB_BUILD_LOCK_ROOT: lockRoot,
      CPB_BUILD_TEST_FAULTS: testCase.fault,
      CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
      CPB_BUILD_TEST_PAUSE_AT: "after-publish-before-fingerprint",
    });
    await waitForPath(path.join(hookRoot, "after-publish-before-fingerprint.ready"));
    await writeFile(probeSource, "export const rollbackDurabilityProbe = \"changed\";\n", "utf8");
    await writeFile(path.join(hookRoot, "after-publish-before-fingerprint.continue"), "continue\n", "utf8");

    const failed = await build;
    assert.notEqual(failed.code, 0, `${testCase.fault} must fail with explicit ambiguity`);
    assert.match(failed.output, new RegExp(`publicationState:${testCase.publicationState}`));
    assert.match(failed.output, /recoveryPaths:/);
    await assert.rejects(access(path.join(isolatedRoot, "dist-tests")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const artifacts = await transactionArtifacts(isolatedRoot, "dist-tests");
    assert.equal(artifacts.some((entry) => entry.includes(".cpb-backup-")), true);
    assert.equal(artifacts.some((entry) => entry.includes(".cpb-rollback-")), true);
  }
});

test("post-publish rollback preserves a successor instead of deleting it on identity mismatch", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-successor-identity");
  const lockRoot = await tempRoot("cpb-publish-successor-locks");
  const hookRoot = await tempRoot("cpb-publish-successor-hooks");
  const probeSource = path.join(isolatedRoot, "tests", "successor-identity-probe.ts");
  await writeFile(probeSource, "export const successorIdentityProbe = \"initial\";\n", "utf8");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(probeSource, "export const successorIdentityProbe = \"candidate\";\n", "utf8");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-publish-before-fingerprint",
  });
  await waitForPath(path.join(hookRoot, "after-publish-before-fingerprint.ready"));
  const outputPath = path.join(isolatedRoot, "dist-tests");
  const displacedPath = path.join(isolatedRoot, "displaced-published-output");
  await rename(outputPath, displacedPath);
  await mkdir(outputPath);
  await writeFile(path.join(outputPath, "successor.txt"), "must survive rollback\n", "utf8");
  await writeFile(probeSource, "export const successorIdentityProbe = \"changed\";\n", "utf8");
  await writeFile(path.join(hookRoot, "after-publish-before-fingerprint.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /identity-safe rollback refused/);
  assert.equal(await readFile(path.join(outputPath, "successor.txt"), "utf8"), "must survive rollback\n");
  assert.equal(
    (await transactionArtifacts(isolatedRoot, "dist-tests")).some((entry) => entry.includes(".cpb-backup-")),
    true,
    "the previous output backup must remain recoverable after successor identity mismatch",
  );
});

test("a stable source cannot commit over a successor output generation", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-publish-successor-commit-fence");
  const lockRoot = await tempRoot("cpb-publish-successor-commit-locks");
  const hookRoot = await tempRoot("cpb-publish-successor-commit-hooks");
  const probeSource = path.join(isolatedRoot, "tests", "successor-commit-probe.ts");
  await writeFile(probeSource, "export const successorCommitProbe = \"initial\";\n", "utf8");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(probeSource, "export const successorCommitProbe = \"candidate\";\n", "utf8");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-publish-before-fingerprint",
  });
  await waitForPath(path.join(hookRoot, "after-publish-before-fingerprint.ready"));
  const outputPath = path.join(isolatedRoot, "dist-tests");
  await rename(outputPath, path.join(isolatedRoot, "displaced-stable-published-output"));
  await mkdir(outputPath);
  await writeFile(path.join(outputPath, "successor.txt"), "must survive commit fencing\n", "utf8");
  await writeFile(path.join(hookRoot, "after-publish-before-fingerprint.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0, "a replaced public generation must not be reported as committed");
  assert.match(failed.output, /commit refused because public output is no longer the published generation/);
  assert.match(failed.output, /committed:false/);
  assert.match(failed.output, /publicationState:published_unverified/);
  assert.equal(await readFile(path.join(outputPath, "successor.txt"), "utf8"), "must survive commit fencing\n");
  assert.equal(
    (await transactionArtifacts(isolatedRoot, "dist-tests")).some((entry) => entry.includes(".cpb-backup-")),
    true,
    "the previous output backup must remain recoverable when commit identity changes",
  );
});

test("a missing rollback backup still quarantines the rejected publication without reconstructing canonical output", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-missing-rollback-backup");
  const lockRoot = await tempRoot("cpb-missing-rollback-locks");
  const hookRoot = await tempRoot("cpb-missing-rollback-hooks");
  const probeSource = path.join(isolatedRoot, "tests", "missing-backup-probe.ts");
  await writeFile(probeSource, "export const missingBackupProbe = \"initial\";\n", "utf8");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  await writeFile(probeSource, "export const missingBackupProbe = \"candidate\";\n", "utf8");

  const build = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-publish-before-fingerprint",
  });
  await waitForPath(path.join(hookRoot, "after-publish-before-fingerprint.ready"));
  const backup = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-backup-"));
  assert.ok(backup);
  await rm(path.join(path.dirname(isolatedRoot), backup), { recursive: true });
  await writeFile(probeSource, "export const missingBackupProbe = \"changed\";\n", "utf8");
  await writeFile(path.join(hookRoot, "after-publish-before-fingerprint.continue"), "continue\n", "utf8");

  const failed = await build;
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /published output quarantined; manual recovery required/);
  assert.match(failed.output, /publicationState:rollback_quarantined_recovery_required/);
  assert.match(failed.output, /committed:true/);
  assert.match(failed.output, /recoveryPaths:/);
  await assert.rejects(access(path.join(isolatedRoot, "dist-tests")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const rejected = (await transactionArtifacts(isolatedRoot, "dist-tests"))
    .find((entry) => entry.includes(".cpb-rollback-"));
  assert.ok(rejected);
  assert.match(
    await readFile(path.join(path.dirname(isolatedRoot), rejected, "tests", "missing-backup-probe.js"), "utf8"),
    /candidate/,
  );
});

test("the acquisition lease blocks a third builder while a stale main lock is quarantined", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-quarantine-acquisition-lease");
  const lockRoot = await tempRoot("cpb-quarantine-acquisition-locks");
  const hookRoot = await tempRoot("cpb-quarantine-acquisition-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  const leaseDir = `${lockDir}.acquire`;
  await writeSyntheticLock(lockDir, {
    token: "dead-main-owner",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });

  const recovering = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-lock-quarantine",
  });
  await waitForPath(path.join(hookRoot, "after-lock-quarantine.ready"));
  await assert.rejects(access(lockDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal((await readJson(path.join(leaseDir, "owner.json"))).kind, "build-acquisition-lease");

  const third = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
  });
  const earlyThird = await Promise.race([
    third.then(() => "settled"),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200)),
  ]);
  assert.equal(earlyThird, "blocked", "third builder entered while the canonical lock was quarantined");
  await writeFile(path.join(hookRoot, "after-lock-quarantine.continue"), "continue\n", "utf8");

  const [recovered, follower] = await Promise.all([recovering, third]);
  assert.equal(recovered.code, 0, `recovering builder failed:\n${recovered.output}`);
  assert.equal(follower.code, 0, `third builder failed:\n${follower.output}`);
  assert.match(follower.output, /up to date/);
  await assert.rejects(access(lockDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(access(leaseDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual((await readdir(lockRoot)).filter((entry) => entry.includes(".quarantine-")), []);
});

test("build lock recovery never overwrites an empty successor directory", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-empty-successor");
  const lockRoot = await tempRoot("cpb-build-empty-successor-locks");
  const hookRoot = await tempRoot("cpb-build-empty-successor-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "dead-main-owner",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });

  const recovering = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "after-lock-quarantine",
  });
  await waitForPath(path.join(hookRoot, "after-lock-quarantine.ready"));
  const quarantineName = (await readdir(lockRoot)).find((entry) => entry.includes(".quarantine-"));
  assert.ok(quarantineName, "expected quarantined predecessor");
  const quarantineDir = path.join(lockRoot, quarantineName);
  await rm(path.join(quarantineDir, "owner.json"));
  await mkdir(lockDir);
  await writeFile(path.join(hookRoot, "after-lock-quarantine.continue"), "continue\n", "utf8");

  const failed = await recovering;
  assert.notEqual(failed.code, 0, "restore must fail closed while an empty successor owns the canonical path");
  assert.match(failed.output, /successor lock preserved/);
  assert.deepEqual(await readdir(lockDir), [], "empty successor directory was overwritten");
  assert.equal(await access(quarantineDir).then(() => true, () => false), true, "quarantine evidence was removed");
});

test("acquisition-lease ABA recovery stays fenced and preserves the quarantined successor", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-acquisition-lease-aba");
  const lockRoot = await tempRoot("cpb-acquisition-lease-aba-locks");
  const hookRoot = await tempRoot("cpb-acquisition-lease-aba-hooks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  const leaseDir = `${lockDir}.acquire`;
  await writeSyntheticLock(leaseDir, {
    token: "dead-acquisition-owner",
    pid: 99_999_999,
    repoRoot: isolatedRoot,
  });

  const recovering = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
    CPB_BUILD_TEST_HOOK_ROOT: hookRoot,
    CPB_BUILD_TEST_PAUSE_AT: "before-acquisition-lease-quarantine,after-acquisition-lease-quarantine",
  });
  await waitForPath(path.join(hookRoot, "before-acquisition-lease-quarantine.ready"));

  await rm(leaseDir, { recursive: true });
  await writeSyntheticLock(leaseDir, {
    token: "live-acquisition-successor",
    pid: process.pid,
    repoRoot: isolatedRoot,
  });
  await writeFile(path.join(hookRoot, "before-acquisition-lease-quarantine.continue"), "continue\n", "utf8");
  await waitForPath(path.join(hookRoot, "after-acquisition-lease-quarantine.ready"));
  await assert.rejects(access(leaseDir), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const third = runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
  });
  const earlyThird = await Promise.race([
    third.then(() => "settled"),
    new Promise<"fenced">((resolve) => setTimeout(() => resolve("fenced"), 200)),
  ]);
  assert.equal(earlyThird, "fenced", "third builder bypassed the OS fence while .acquire was quarantined");
  await writeFile(path.join(hookRoot, "after-acquisition-lease-quarantine.continue"), "continue\n", "utf8");

  const [failed, follower] = await Promise.all([recovering, third]);
  assert.notEqual(failed.code, 0, "ABA recovery must require explicit quarantine recovery");
  assert.match(failed.output, /automatic canonical reconstruction refused/);
  assert.match(failed.output, /publicationState:lock_quarantined_recovery_required/);
  assert.match(failed.output, /recoveryPaths:/);
  assert.equal(follower.code, 0, `fenced follower failed:\n${follower.output}`);
  assert.match(follower.output, /published dist-tests/);
  const quarantine = (await readdir(lockRoot)).find((entry) => entry.includes(".acquire.quarantine-"));
  assert.ok(quarantine);
  assert.equal((await readJson(path.join(lockRoot, quarantine, "owner.json"))).token, "live-acquisition-successor");
});

test("a reused live PID with a different incarnation does not pin a stale build lock", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-build-lock-pid-reuse");
  const lockRoot = await tempRoot("cpb-build-lock-pid-reuse-locks");
  const lockDir = await buildLockPath(isolatedRoot, "tests", lockRoot);
  await writeSyntheticLock(lockDir, {
    token: "reused-pid-old-generation",
    pid: process.pid,
    repoRoot: isolatedRoot,
    processIdentity: {
      pid: process.pid,
      birthId: "old-process-generation",
      incarnation: `${process.pid}:old-process-generation`,
      capturedAt: "2000-01-01T00:00:00.000Z",
      birthIdPrecision: "exact",
    },
  });

  const recovered = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_LOCK_WAIT_MS: "5000",
  });
  assert.equal(recovered.code, 0, `PID-reuse stale lock was treated as live:\n${recovered.output}`);
  assert.match(await readFile(path.join(isolatedRoot, "dist-tests", ".cpb-build.json"), "utf8"), /"target": "tests"/);
  assert.deepEqual(await readdir(lockRoot), []);
});

test("EIO and EACCES filesystem probes fail explicitly instead of masquerading as absence", async () => {
  const isolatedRoot = await makeMinimalBuildSource("cpb-strict-absence-errors");
  const lockRoot = await tempRoot("cpb-strict-absence-locks");
  const initial = await runNpmScript(isolatedRoot, "build:tests", { CPB_BUILD_LOCK_ROOT: lockRoot });
  assert.equal(initial.code, 0, `initial build failed:\n${initial.output}`);
  const metadataPath = path.join(isolatedRoot, "dist-tests", ".cpb-build.json");
  const metadata = await readFile(metadataPath, "utf8");

  const readFailed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "published-fingerprint-read",
  });
  assert.notEqual(readFailed.code, 0);
  assert.match(readFailed.output, /published-fingerprint-read.*EIO/);
  assert.equal(await readFile(metadataPath, "utf8"), metadata);

  const inspectFailed = await runNpmScript(isolatedRoot, "build:tests", {
    CPB_BUILD_LOCK_ROOT: lockRoot,
    CPB_BUILD_TEST_FAULTS: "lock-inspect",
  });
  assert.notEqual(inspectFailed.code, 0);
  assert.match(inspectFailed.output, /lock-inspect.*EACCES/);
  assert.equal(await readFile(metadataPath, "utf8"), metadata);
  assert.deepEqual((await readdir(lockRoot)).filter((entry) => entry.endsWith(".acquire")), []);
});
