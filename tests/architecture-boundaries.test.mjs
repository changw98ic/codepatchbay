import { readFile, readdir } from "node:fs/promises";
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
