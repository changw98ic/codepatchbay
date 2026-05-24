import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "target" || entry.name === "node_modules") continue;
        await walk(full);
      } else if (/\.(js|mjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(path.join(repoRoot, dir));
  return out;
}

test("core stays pure", async () => {
  for (const file of await listFiles("core")) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from ["'][.\/]+(?:server|bridges|cli|runtime)\//, `${path.relative(repoRoot, file)} imports outside core`);
    assert.doesNotMatch(source, /import\(["'][.\/]+(?:server)\//, `${path.relative(repoRoot, file)} dynamic-imports server`);
  }
});

test("runtime does not import from bridges", async () => {
  const offenders = [];
  for (const file of await listFiles("runtime")) {
    const source = await readFile(file, "utf8");
    if (source.includes("../bridges/")) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("server does not import from bridges", async () => {
  const offenders = [];
  for (const file of await listFiles("server")) {
    const source = await readFile(file, "utf8");
    if (source.includes("../bridges/") || source.includes("../../bridges/")) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("server ACP pool imports without CLI argv side effects", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "await import('./server/services/acp-pool.js'); console.log('ok');",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("CLI-style executable modules are import safe", async () => {
  const modules = [
    "./runtime/acp-client.mjs",
    "./bridges/run-phase.mjs",
    "./bridges/run-pipeline.mjs",
  ];

  for (const mod of modules) {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(mod)}); console.log('ok')`,
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${mod}: ${result.stderr || result.stdout}`);
  }
});

test("server-to-runtime imports are limited to the exception list", async () => {
  const ALLOWED_SERVER_RUNTIME_IMPORTS = new Set([
    "server/services/acp-pool.js",
    // acp-pool imports runtime/acp-client-core.mjs for managed in-process sessions.
    // Core module re-exports AcpClient class — safe to import without CLI side effects.
    // Remove entry after acp-client-core.mjs migrates to server/services/.
  ]);

  const offenders = [];
  for (const file of await listFiles("server")) {
    if (ALLOWED_SERVER_RUNTIME_IMPORTS.has(path.relative(repoRoot, file))) continue;
    const source = await readFile(file, "utf8");
    const runtimeImport = source.match(/from ["'][.\/]+runtime\/|import\(["'][.\/]+runtime\//);
    if (runtimeImport) {
      offenders.push(`${path.relative(repoRoot, file)}: ${runtimeImport[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "server files importing runtime must be in ALLOWED_SERVER_RUNTIME_IMPORTS");
});

// ---------------------------------------------------------------------------
// D48: Remote Runner Boundary Contract - RED phase
// ---------------------------------------------------------------------------

test("D48: runner-contract exports boundary version and contract schema", async () => {
  const mod = await import("../core/workflow/runner-contract.js");

  assert.equal(typeof mod.BOUNDARY_VERSION, "string", "BOUNDARY_VERSION must be a string");
  assert.ok(mod.BOUNDARY_VERSION.length > 0, "BOUNDARY_VERSION must not be empty");

  assert.ok(mod.CONTRACT, "CONTRACT must be exported");
  const contract = mod.CONTRACT;
  const requiredKeys = ["jobInput", "artifactOutput", "eventStream", "secretBoundary", "cancellation"];
  for (const key of requiredKeys) {
    assert.ok(Object.hasOwn(contract, key), `CONTRACT must define "${key}"`);
  }
});

test("D48: runner-contract exports validateRunnerAdapter and createLocalRunnerAdapter", async () => {
  const mod = await import("../core/workflow/runner-contract.js");

  assert.equal(typeof mod.validateRunnerAdapter, "function", "validateRunnerAdapter must be a function");
  assert.equal(typeof mod.createLocalRunnerAdapter, "function", "createLocalRunnerAdapter must be a function");
});

test("D48: local adapter validates job input fields and forwards to injected runner", async () => {
  const { createLocalRunnerAdapter } = await import("../core/workflow/runner-contract.js");

  let received = null;
  const fakeRunner = async (input) => { received = input; return { exitCode: 0 }; };

  const adapter = createLocalRunnerAdapter(fakeRunner);

  const validInput = {
    project: "test-project",
    jobId: "job-001",
    task: "Add dark mode",
    workflow: "standard",
    sourcePath: "/tmp/test-project",
    worktree: "/tmp/worktrees/job-001",
    envRefs: { API_KEY: "secret-ref://vault/api-key" },
  };

  const result = await adapter.run(validInput);
  assert.equal(result.exitCode, 0);
  assert.deepStrictEqual(received, validInput);
});

test("D48: local adapter rejects job input missing required fields", async () => {
  const { createLocalRunnerAdapter } = await import("../core/workflow/runner-contract.js");

  const adapter = createLocalRunnerAdapter(async () => ({ exitCode: 0 }));

  const badInput = { project: "test-project" };

  await assert.rejects(
    () => adapter.run(badInput),
    { message: /jobInput/i },
  );
});

test("D48: local adapter rejects job input containing raw secrets", async () => {
  const { createLocalRunnerAdapter } = await import("../core/workflow/runner-contract.js");

  const adapter = createLocalRunnerAdapter(async () => ({ exitCode: 0 }));

  const inputWithSecret = {
    project: "test-project",
    jobId: "job-002",
    task: "Do something",
    workflow: "standard",
    sourcePath: "/tmp/test",
    worktree: "/tmp/wt",
    envRefs: {},
    secrets: { API_KEY: "super-secret-value-12345" },
  };

  await assert.rejects(
    () => adapter.run(inputWithSecret),
    { message: /secret/i },
  );
});

test("D48: runner-contract has no remote/network runner exports or imports", async () => {
  const mod = await import("../core/workflow/runner-contract.js");

  assert.equal(mod.createRemoteRunner, undefined, "must not export createRemoteRunner");
  assert.equal(mod.createNetworkRunner, undefined, "must not export createNetworkRunner");

  const source = await readFile(
    path.resolve(import.meta.dirname, "..", "core", "workflow", "runner-contract.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /import.*(?:fetch|node:http|node:https|node:net)\b/, "must not import network modules");
  assert.doesNotMatch(source, /createRemoteRunner|createNetworkRunner/, "must not contain remote runner implementation");
});

test("D48: docs/architecture/runner-boundary.md exists with required sections", async () => {
  const docPath = path.resolve(import.meta.dirname, "..", "docs", "architecture", "runner-boundary.md");
  const st = await stat(docPath);
  assert.ok(st.isFile(), "runner-boundary.md must be a file");

  const content = await readFile(docPath, "utf8");
  const requiredSections = [
    "Job Input",
    "Artifact Output",
    "Event Stream",
    "Secret Boundary",
    "Cancellation",
  ];
  for (const section of requiredSections) {
    assert.match(content, new RegExp(section, "i"), `must mention "${section}"`);
  }

  assert.doesNotMatch(content, /remote runner implementation/i, "must not describe remote runner implementation");
});

test("D48: validateRunnerAdapter validates adapter shape", async () => {
  const { validateRunnerAdapter, createLocalRunnerAdapter } = await import("../core/workflow/runner-contract.js");

  const goodAdapter = createLocalRunnerAdapter(async () => ({ exitCode: 0 }));
  assert.doesNotThrow(() => validateRunnerAdapter(goodAdapter));

  assert.throws(
    () => validateRunnerAdapter({}),
    { message: /adapter/i },
    "empty object should fail validation",
  );

  assert.throws(
    () => validateRunnerAdapter(null),
    { message: /adapter/i },
    "null should fail validation",
  );
});
