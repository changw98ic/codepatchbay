import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  REPO_ROOT,
  scanBoundary,
  detectImportViolations,
  scanReexportShells,
  scanCompatKeywords,
  scanTextFragments,
  detectTextFragments,
} from "./helpers/boundary-scanner.mjs";

const DELETED_RUNTIME_ENTRIES = [
  "runtime/acp-client-core.mjs",
  "runtime/acp-client.mjs",
  "runtime/acp-pool.js",
  "runtime/apply-variant.js",
  "runtime/delete-guard.js",
];

const FORBIDDEN_RUNTIME_IMPORTS = new Set(["server"]);
const BRIDGE_ENTRY_FILES = [
  "bridges/engine-bridge.js",
  "bridges/runtime-services.js",
];

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

test("bridges directory contains only runtime boundary adapters", async () => {
  const bridgeFiles = (await listFiles(path.join(REPO_ROOT, "bridges")))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(bridgeFiles, BRIDGE_ENTRY_FILES);
});

test("runtime old ACP entry files are deleted", async () => {
  for (const relativePath of DELETED_RUNTIME_ENTRIES) {
    await assert.rejects(
      () => access(path.join(REPO_ROOT, relativePath)),
      { code: "ENOENT" },
      `${relativePath} must stay deleted`,
    );
  }
});

test("runtime source does not reference deleted runtime ACP entries", async () => {
  const hits = await scanTextFragments({
    scanDir: path.join(REPO_ROOT, "runtime"),
    fragments: DELETED_RUNTIME_ENTRIES,
  });
  assert.deepEqual(hits, [], "runtime/ should not reference deleted ACP entry files. Found:\n" +
    hits.join("\n"));
});

test("runtime source does not import server implementation modules", async () => {
  const violations = await scanBoundary({
    scanDir: path.join(REPO_ROOT, "runtime"),
    forbiddenTargets: FORBIDDEN_RUNTIME_IMPORTS,
  });
  assert.deepEqual(violations, []);
});

test("runtime has no re-export shells pointing to bridges (compat cleanup check)", async () => {
  const shells = await scanReexportShells({
    scanDir: path.join(REPO_ROOT, "runtime"),
    reexportTargets: ["bridges"],
  });
  assert.deepEqual(shells, [], "runtime/ should not contain export * shells pointing to bridges/. " +
    "These are backward-compat re-exports that must be deleted by hardcut lane. Found:\n" +
    shells.join("\n"));
});

test("runtime has no backward-compat keywords in source files", async () => {
  const hits = await scanCompatKeywords({
    scanDir: path.join(REPO_ROOT, "runtime"),
    keywords: ["backward compatibility", "re-export shell", "re-export shell kept"],
  });
  assert.deepEqual(hits, [], "runtime/ should not contain backward-compat markers. Found:\n" +
    hits.join("\n"));
});

test("scanner catches deleted runtime ACP entry references (negative)", () => {
  const source = `const old = "runtime/acp-client.mjs"`;
  const violations = detectTextFragments(source, DELETED_RUNTIME_ENTRIES);
  assert.equal(violations.length, 1);
  assert.equal(violations[0], "runtime/acp-client.mjs");
});

test("scanner catches runtime static import from server layer (negative)", () => {
  const source = `import { appendEvent } from "../server/services/event-store.js"`;
  const fakeFile = path.join(REPO_ROOT, "runtime/test.js");
  const violations = detectImportViolations(source, fakeFile, FORBIDDEN_RUNTIME_IMPORTS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].target, "server");
});
