import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, afterEach } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { FailureKind } from "../core/contracts/failure.js";
import {
  ensureLocalCodeIndex,
  localCodeIndexStatus,
  queryLocalCodeIndex,
} from "../core/indexing/local-code-index/index.js";
import type {
  LocalCodeIndexQueryResult,
} from "../core/indexing/local-code-index/contracts.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import {
  generateProjectCapabilityMaps,
  projectCapabilityMapGate,
} from "../server/services/project-capability-map.js";
import { readJson } from "./helpers.js";

// ── Temp directory management ──

const tempDirs: string[] = [];

/**
 * Create a temp directory with realpath resolution.
 *
 * On macOS, mkdtemp returns paths under /var/folders/ (a symlink to
 * /private/var/folders/).  registerProjectWithReceipt canonicalises
 * sourcePath via realpath, so the index must be built with the same
 * resolved path to avoid a key mismatch.
 */
async function tempDir(label: string): Promise<string> {
  const raw = await mkdtemp(path.join(tmpdir(), `lci-cm-${label}-`));
  const resolved = await realpath(raw);
  tempDirs.push(resolved);
  return resolved;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

// ── Helpers ──

async function createSourceFixture(): Promise<string> {
  const sourcePath = await tempDir("source");
  await mkdir(path.join(sourcePath, "server", "orchestrator"), { recursive: true });
  await mkdir(path.join(sourcePath, "tests"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "server", "orchestrator", "scheduler.js"),
    "export class Scheduler {}\n",
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "tests", "scheduler.test.js"),
    "import 'node:test';\n",
    "utf8",
  );
  await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ name: "capmap-fixture", private: true, type: "module" }, null, 2),
    "utf8",
  );

  // Initialize a git repo so the local code index can resolve file paths
  // correctly (commonGitDir must be set for extraction to work).
  await execFileAsync("git", ["init", "-q"], { cwd: sourcePath });
  await execFileAsync("git", ["add", "."], { cwd: sourcePath });
  await execFileAsync("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@test",
    "commit", "-q", "-m", "init",
  ], { cwd: sourcePath });

  return sourcePath;
}

function asInventory(result: LocalCodeIndexQueryResult): LocalCodeIndexQueryResult & { kind: "inventory" } {
  assert.strictEqual(result.kind, "inventory");
  return result as LocalCodeIndexQueryResult & { kind: "inventory" };
}

// ── Tests ──

test("localCodeIndexStatus reports missing when no index has been built", async () => {
  const sourcePath = await createSourceFixture();
  const cpbRoot = await tempDir("cpbroot-no-index");

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });

  assert.equal(status.available, false);
  assert.equal(status.reason, "missing_local_code_index");
});

test("registerProject persists high-confidence capability maps from local code index", async () => {
  const hubRoot = await tempDir("hub");
  const sourcePath = await createSourceFixture();
  const cpbRoot = await tempDir("cpbroot-reg");

  // Build the v2 local code index.
  const ensureResult = await ensureLocalCodeIndex({ cpbRoot, sourcePath, force: true });
  assert.equal(ensureResult.available, true);
  assert.equal(ensureResult.ref.schemaVersion, 2);

  // Verify status is available before registration.
  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true);

  // Register the project — should persist capability maps.
  // registerProjectWithReceipt canonicalises sourcePath via realpath internally,
  // so the index keys must already match the realpath'd sourcePath.
  const project = await registerProject(hubRoot, { id: "flow", sourcePath, cpbRoot });
  const stored = (await readJson(path.join(hubRoot, "projects.json"))).projects.flow;

  assert.equal(project.metadata.capabilityMapConfidence, "high");
  assert.equal(stored.metadata.capabilityMapConfidence, "high");
  assert.equal(stored.metadata.codeIndexReadiness.available, true);
  assert.equal(stored.metadata.project_capability_map.confidence, "high");
  assert.ok(stored.metadata.project_capability_map.coreModules.includes("server/orchestrator/scheduler.js"));
  assert.ok(stored.metadata.project_capability_map.testSurfaces.includes("tests/scheduler.test.js"));
  assert.equal(stored.metadata.safety_boundary_map.confidence, "high");
  assert.equal(stored.metadata.high_risk_area_map.confidence, "high");
});

test("generateProjectCapabilityMaps uses queryLocalCodeIndex inventory to build maps", async () => {
  const sourcePath = await createSourceFixture();
  const cpbRoot = await tempDir("cpbroot-gen");

  // Build the index first.
  await ensureLocalCodeIndex({ cpbRoot, sourcePath, force: true });

  // Generate capability maps via the v2 API (uses queryLocalCodeIndex internally).
  const maps = await generateProjectCapabilityMaps({ cpbRoot, sourcePath });

  assert.equal(maps.capabilityMapConfidence, "high");
  assert.equal(maps.project_capability_map.confidence, "high");
  assert.equal(maps.project_capability_map.source, "local-code-index");
  assert.ok(Array.isArray(maps.project_capability_map.coreModules));
  assert.ok(maps.project_capability_map.coreModules.includes("server/orchestrator/scheduler.js"));
  assert.ok(maps.project_capability_map.testSurfaces.includes("tests/scheduler.test.js"));
  assert.equal(maps.safety_boundary_map.confidence, "high");
  assert.equal(maps.high_risk_area_map.confidence, "high");
  assert.ok(maps.project_capability_map.summary.nodeCount > 0);
  assert.ok(maps.project_capability_map.summary.languages.javascript >= 2);

  // Verify the code index readiness metadata is present.
  assert.equal(maps.codeIndexReadiness.available, true);
  assert.equal(maps.codeIndexReadiness.ref.schemaVersion, 2);
});

test("generateProjectCapabilityMaps reports low confidence when ast-grep is unavailable", async () => {
  const sourcePath = await createSourceFixture();
  const cpbRoot = await tempDir("cpbroot-no-parser");

  await ensureLocalCodeIndex({
    cpbRoot,
    sourcePath,
    force: true,
    astGrepBinaryPath: path.join(cpbRoot, "missing-ast-grep"),
  });
  const maps = await generateProjectCapabilityMaps({ cpbRoot, sourcePath });

  assert.equal(maps.capabilityMapConfidence, "low");
  assert.equal(maps.project_capability_map.confidence, "low");
  assert.equal(maps.safety_boundary_map.confidence, "low");
  assert.equal(maps.high_risk_area_map.confidence, "low");
  assert.deepEqual(projectCapabilityMapGate(maps), {
    available: false,
    reason: "project_capability_map_not_high_confidence",
    confidence: "low",
  });
});

test("generateProjectCapabilityMaps paginates inventories larger than 500 files", async () => {
  const sourcePath = await tempDir("large-source");
  const cpbRoot = await tempDir("cpbroot-large-source");
  await mkdir(path.join(sourcePath, "notes"), { recursive: true });
  await Promise.all(Array.from({ length: 505 }, (_, index) =>
    writeFile(path.join(sourcePath, "notes", `note-${String(index).padStart(3, "0")}.txt`), `${index}\n`, "utf8")
  ));

  await ensureLocalCodeIndex({
    cpbRoot,
    sourcePath,
    force: true,
    astGrepBinaryPath: path.join(cpbRoot, "missing-ast-grep"),
  });
  const maps = await generateProjectCapabilityMaps({ cpbRoot, sourcePath });

  assert.equal(maps.project_capability_map.summary.fileCount, 505);
});

test("queryLocalCodeIndex inventory returns indexed files", async () => {
  const sourcePath = await createSourceFixture();
  const cpbRoot = await tempDir("cpbroot-query");

  const ensureResult = await ensureLocalCodeIndex({ cpbRoot, sourcePath, force: true });

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true, `status should be available, got reason=${status.reason}`);

  const result = asInventory(
    await queryLocalCodeIndex(
      ensureResult.ref,
      { kind: "inventory", limit: 100 },
      { cpbRoot },
    ),
  );

  assert.ok(result.files.length >= 3, `expected at least 3 files, got ${result.files.length}`);
  const paths = result.files.map((f) => f.path);
  assert.ok(paths.some((p) => p.includes("scheduler.js")));
  assert.ok(paths.some((p) => p.includes("scheduler.test.js")));
  assert.ok(paths.some((p) => p.includes("README.md")));
});

test("generateProjectCapabilityMaps throws LocalCodeIndexUnavailableError when index is missing", async () => {
  const sourcePath = await createSourceFixture();
  const cpbRoot = await tempDir("cpbroot-missing");

  await assert.rejects(
    generateProjectCapabilityMaps({ cpbRoot, sourcePath }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, FailureKind.LOCAL_CODE_INDEX_UNAVAILABLE);
      return true;
    },
  );
});
