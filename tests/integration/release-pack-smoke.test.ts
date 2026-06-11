// @ts-nocheck
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  REQUIRED_EXECUTOR_FILES,
  assertExecutorRoot,
} from "../../server/services/executor-root.js";
import {
  checkReleaseCompatibility,
  installRelease,
} from "../../server/services/release-store.js";

const TEST_ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXECUTOR_ROOT = existsSync(path.join(TEST_ROOT, "cli", "cpb.js"))
  ? TEST_ROOT
  : path.join(TEST_ROOT, "dist");
const PACKAGE_ROOT = EXECUTOR_ROOT;
const REQUIRED_SHARED_FILES = [
  "shared/fs-utils.js",
  "shared/logger.js",
  "shared/orchestrator/assignment-store.js",
  "shared/orchestrator/worker-store.js",
];

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function relativeRepoPath(file) {
  return path.relative(EXECUTOR_ROOT, file).split(path.sep).join("/");
}

function writeStubFile(root, relativePath, content = "// stub\n") {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function hasPackedPath(packedPaths, relativePath) {
  return packedPaths.has(relativePath) || packedPaths.has(`dist/${relativePath}`);
}

test("executor manifest lists the exact shared layer file set", () => {
  const actualSharedFiles = listFiles(path.join(EXECUTOR_ROOT, "shared"))
    .map(relativeRepoPath)
    .sort();
  assert.deepEqual(actualSharedFiles, [...REQUIRED_SHARED_FILES].sort());

  for (const required of REQUIRED_SHARED_FILES) {
    assert.ok(
      REQUIRED_EXECUTOR_FILES.includes(required),
      `REQUIRED_EXECUTOR_FILES must include ${required}`,
    );
  }
});

test("npm pack includes all REQUIRED_EXECUTOR_FILES", () => {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  const packMeta = JSON.parse(raw);
  const packedPaths = new Set(packMeta[0].files.map((f) => f.path));

  const missing = [];
  for (const required of REQUIRED_EXECUTOR_FILES) {
    if (!packedPaths.has(required)) {
      missing.push(required);
    }
  }

  assert.equal(
    missing.length,
    0,
    `Missing from npm pack: ${missing.join(", ")}`,
  );

  const unexpectedWikiArtifacts = [...packedPaths]
    .filter((packedPath) => {
      if (!/^(?:dist\/)?wiki\//.test(packedPath)) return false;
      if (/^(?:dist\/)?wiki\/schema\.md$/.test(packedPath)) return false;
      if (/^(?:dist\/)?wiki\/projects\/_template(?:\/|$)/.test(packedPath)) return false;
      return true;
    })
    .sort();
  assert.deepEqual(
    unexpectedWikiArtifacts,
    [],
    `npm pack must not include non-template wiki artifacts: ${unexpectedWikiArtifacts.slice(0, 10).join(", ")}`,
  );

  assert.ok(
    hasPackedPath(packedPaths, "web/dist/index.html"),
    "npm pack must include the compiled web UI",
  );

  assert.ok(
    hasPackedPath(packedPaths, "core/agents/drivers/browser/fixtures/pages/mock-chat.html"),
    "npm pack must include browser mock fixture HTML",
  );
  assert.ok(
    hasPackedPath(packedPaths, "core/agents/drivers/browser/fixtures/pages/dev-null.html"),
    "npm pack must include browser dev-null fixture HTML",
  );

  const runtimeStateArtifacts = [...packedPaths]
    .filter((packedPath) => packedPath.startsWith("dist/server/.omc/") || packedPath.startsWith("server/.omc/"))
    .sort();
  assert.deepEqual(
    runtimeStateArtifacts,
    [],
    `npm pack must not include server runtime state: ${runtimeStateArtifacts.slice(0, 10).join(", ")}`,
  );

  const compiledTestArtifacts = [...packedPaths]
    .filter((packedPath) => packedPath.startsWith("dist/tests/") || packedPath.startsWith("tests/"))
    .sort();
  assert.deepEqual(
    compiledTestArtifacts,
    [],
    `npm pack must not include compiled tests: ${compiledTestArtifacts.slice(0, 10).join(", ")}`,
  );
});

test("assertExecutorRoot succeeds for executor root", async () => {
  const root = await assertExecutorRoot(EXECUTOR_ROOT);
  assert.equal(root, EXECUTOR_ROOT);
});

test("assertExecutorRoot rejects directory missing required files", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cpb-smoke-"));
  try {
    await assert.rejects(() => assertExecutorRoot(tmp), /executor root is missing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("assertExecutorRoot reports which file is missing", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cpb-smoke-"));
  try {
    mkdirSync(path.join(tmp, "cli"), { recursive: true });
    writeFileSync(path.join(tmp, "cpb"), "#!/bin/sh");
    writeFileSync(path.join(tmp, "cli", "cpb.js"), "// stub");
    // Has cpb and cli/cpb.js but missing most other files

    await assert.rejects(
      () => assertExecutorRoot(tmp),
      /executor root is missing bridges\/engine-bridge\.js/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("release install tolerates npm package executor roots without package-lock", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cpb-release-no-lock-"));
  const sourceRoot = path.join(tmp, "source");
  const destRoot = path.join(tmp, "releases");

  try {
    for (const dir of ["profiles", "skills", "templates"]) {
      mkdirSync(path.join(sourceRoot, dir), { recursive: true });
    }
    writeStubFile(sourceRoot, "package.json", JSON.stringify({
      name: "codepatchbay",
      version: "0.0.0-test",
      type: "module",
    }, null, 2));
    writeStubFile(sourceRoot, "cpb", "#!/usr/bin/env node\n");
    for (const required of REQUIRED_EXECUTOR_FILES) {
      writeStubFile(sourceRoot, required);
    }

    const manifest = await installRelease({
      sourceRoot,
      destRoot,
      name: "no-lock",
    });

    assert.equal(manifest.releaseId, "no-lock");
    assert.equal(manifest.codeVersion, "0.0.0-test");
    await assert.rejects(
      () => access(path.join(manifest.installedPath, "package-lock.json")),
      /ENOENT/,
    );

    const compatibility = await checkReleaseCompatibility({
      releaseId: "no-lock",
      destRoot,
    });
    assert.deepEqual(compatibility.failures, []);
    assert.equal(compatibility.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("critical runtime imports resolve", async () => {
  const criticalImports = [
    "server/services/acp-client-core.js",
    "server/services/release-store.js",
    "server/services/hub-queue.js",
    "server/services/event-store.js",
    "server/services/hub-registry.js",
    "shared/orchestrator/assignment-store.js",
    "shared/orchestrator/worker-store.js",
    "shared/fs-utils.js",
    "shared/logger.js",
    "bridges/runtime-services.js",
    "server/services/engine-runner.js",
    "server/services/dual-research.js",
    "server/services/local-smoke.js",
    "server/services/browser-agent-acp.js",
    "server/services/evolve-multi-cli.js",
    "server/services/review-dispatch-runner.js",
    "runtime/evolve/multi-evolve.js",
    "runtime/worker/managed-worker.js",
  ];

  for (const mod of criticalImports) {
    const resolved = await import(pathToFileURL(path.join(EXECUTOR_ROOT, mod)).href);
    assert.ok(resolved, `Failed to import ${mod}`);
  }
});
