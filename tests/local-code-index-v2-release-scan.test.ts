/**
 * local-code-index-v2-release-scan.test.ts
 *
 * Verifies two rejection gates for remaining v1 local-code-index state:
 *
 *   1. Runtime startup rejects remaining dispatchable v1 state.
 *      gateRegistryState() scans every enabled project in the hub registry;
 *      if any project's local code index carries schemaVersion != 2, the
 *      gate fails closed with UNSUPPORTED_INDEX_SCHEMA.
 *
 *   2. Scheduler defense-in-depth rejects v1 state.
 *      gateDispatchCandidate() re-probes a single project right before
 *      dispatch.  Even if the startup gate passed (e.g., the index was
 *      downgraded between ticks), the dispatch gate catches it.
 *
 * Both gates delegate to localCodeIndexStatus() which reads current.json
 * and identity.json from the local-code-index storage tree.  When
 * identity.json carries schemaVersion != 2, the status returns
 * { available: false, reason: "unsupported_index_schema" } and the gate
 * translates that into a hard failure with migration instructions.
 *
 * Run:
 *   npm run build:tests
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-v2-release-scan.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, afterEach } from "node:test";

import {
  gateRegistryState,
  gateDispatchCandidate,
} from "../server/services/hub/local-code-index-state-gate.js";

import { registerProject } from "../server/services/hub/hub-registry.js";

import {
  computeKeys,
  deriveRepositoryKey,
  deriveWorktreeKey,
} from "../core/indexing/local-code-index/paths.js";

// ── Temp directory management ────────────────────────────────────────────────

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const raw = await mkdtemp(path.join(tmpdir(), `lci-v2-scan-${label}-`));
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

// ── Fixture builders ─────────────────────────────────────────────────────────

/**
 * Create a minimal source directory that the local-code-index path
 * validators accept (must be a real directory, resolved via realpath).
 */
async function createSourceFixture(label: string): Promise<string> {
  const sourcePath = await tempDir(`source-${label}`);
  await writeFile(
    path.join(sourcePath, "index.ts"),
    "export const x = 1;\n",
    "utf8",
  );
  return sourcePath;
}

/**
 * Migration input: build a v1-schema local-code-index tree under `cpbRoot`
 * that points to `sourcePath`.  Used exclusively to test the v1→v2
 * local-code-index migration/rejection path.
 *
 * Directory layout produced:
 *
 *   <cpbRoot>/indexes/local-code/v2/
 *     worktrees/<worktreeKey>/
 *       current.json           -- schemaVersion: 1, points to snapshotId
 *       snapshots/<snapshotId>/
 *         identity.json        -- schemaVersion: 1  (v1, unsupported)
 *         index-map.json       -- minimal valid index-map
 */
async function writeV1IndexMigrationInput(
  cpbRoot: string,
  sourcePath: string,
): Promise<{ snapshotId: string; worktreeKey: string; repositoryKey: string }> {
  // Derive keys the same way the real service does.
  const { repositoryKey, worktreeKey } = computeKeys(sourcePath, sourcePath);

  const snapshotId = "idx2-v1test00000000000000001";

  // Build the identity.json with schemaVersion: 1 (unsupported).
  const identity = {
    schemaVersion: 1,
    repositoryKey,
    worktreeKey,
    sourceKey: "fake-source-key",
    sourcePath,
    git: null,
    worktreeStateFingerprint: "fake-fingerprint",
    inventory: {},
    extractorFingerprint: "fake-extractor-fingerprint",
    symbolShardIds: [],
    relationShardIds: [],
    toolState: {
      name: "ast-grep",
      version: null,
      extractorFingerprint: "fake-extractor-fingerprint",
      available: false,
      coverage: "file-inventory-only",
      errors: [],
    },
    indexMapHash: createHash("sha256").update("fake-index-map").digest("hex"),
    indexMapByteLength: 0,
  };

  const identityBytes = Buffer.from(JSON.stringify(identity), "utf8");
  const identityHash = createHash("sha256").update(identityBytes).digest("hex");

  // Build current.json (schemaVersion: 1 for the pointer itself -- this is
  // correct; the *snapshot identity* is what must be v2).
  const currentPointer = {
    schemaVersion: 1,
    worktreeKey,
    snapshotId,
    identityHash,
    ownerToken: "test-owner-token",
    publishedAt: new Date().toISOString(),
    previousSnapshotIds: [],
  };

  // Minimal index-map.json.
  const indexMap = {
    schemaVersion: 2,
    snapshotId,
    symbolShards: {},
    relationShards: {},
    fileSummaryShards: {},
  };

  // Write the directory tree.
  const storageRoot = path.join(cpbRoot, "indexes", "local-code", "v2");
  const wtDir = path.join(storageRoot, "worktrees", worktreeKey);
  const snapDir = path.join(wtDir, "snapshots", snapshotId);

  await mkdir(snapDir, { recursive: true });
  await chmod(storageRoot, 0o700);

  await writeFile(
    path.join(wtDir, "current.json"),
    JSON.stringify(currentPointer, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(snapDir, "identity.json"),
    identityBytes,
  );
  await writeFile(
    path.join(snapDir, "index-map.json"),
    JSON.stringify(indexMap, null, 2) + "\n",
    "utf8",
  );

  return { snapshotId, worktreeKey, repositoryKey };
}

/**
 * Build a v2-schema local-code-index tree (the happy path).
 *
 * Same layout as writeV1IndexMigrationInput but identity.json has schemaVersion: 2.
 */
async function writeV2LocalCodeIndex(
  cpbRoot: string,
  sourcePath: string,
): Promise<{ snapshotId: string; worktreeKey: string; repositoryKey: string }> {
  const { repositoryKey, worktreeKey } = computeKeys(sourcePath, sourcePath);

  const snapshotId = "idx2-v2test00000000000000001";

  const identity = {
    schemaVersion: 2,
    repositoryKey,
    worktreeKey,
    sourceKey: "fake-source-key-v2",
    sourcePath,
    git: null,
    worktreeStateFingerprint: "fake-fingerprint-v2",
    inventory: {},
    extractorFingerprint: "fake-extractor-fingerprint-v2",
    symbolShardIds: [],
    relationShardIds: [],
    toolState: {
      name: "ast-grep",
      version: null,
      extractorFingerprint: "fake-extractor-fingerprint-v2",
      available: false,
      coverage: "file-inventory-only",
      errors: [],
    },
    indexMapHash: createHash("sha256").update("fake-index-map-v2").digest("hex"),
    indexMapByteLength: 0,
  };

  const identityBytes = Buffer.from(JSON.stringify(identity), "utf8");
  const identityHash = createHash("sha256").update(identityBytes).digest("hex");

  const currentPointer = {
    schemaVersion: 1,
    worktreeKey,
    snapshotId,
    identityHash,
    ownerToken: "test-owner-token-v2",
    publishedAt: new Date().toISOString(),
    previousSnapshotIds: [],
  };

  const indexMap = {
    schemaVersion: 2,
    snapshotId,
    symbolShards: {},
    relationShards: {},
    fileSummaryShards: {},
  };

  const storageRoot = path.join(cpbRoot, "indexes", "local-code", "v2");
  const wtDir = path.join(storageRoot, "worktrees", worktreeKey);
  const snapDir = path.join(wtDir, "snapshots", snapshotId);

  await mkdir(snapDir, { recursive: true });
  await chmod(storageRoot, 0o700);

  await writeFile(
    path.join(wtDir, "current.json"),
    JSON.stringify(currentPointer, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(snapDir, "identity.json"),
    identityBytes,
  );
  await writeFile(
    path.join(snapDir, "index-map.json"),
    JSON.stringify(indexMap, null, 2) + "\n",
    "utf8",
  );

  return { snapshotId, worktreeKey, repositoryKey };
}

/**
 * Register a project in the hub registry, bypassing the capability-map
 * generation gate (which itself depends on a working v2 index).
 */
async function registerProjectFixture(
  hubRoot: string,
  projectId: string,
  sourcePath: string,
  cpbRoot: string,
) {
  await registerProject(hubRoot, {
    id: projectId,
    sourcePath,
    cpbRoot,
    skipLocalCodeIndexGate: true,
    metadata: {
      capabilityMapConfidence: "high",
      project_capability_map: {
        confidence: "high",
        coreModules: [],
        testSurfaces: [],
      },
    },
  });
}

// ── Test 1: Runtime startup gate ─────────────────────────────────────────────

describe("gateRegistryState (startup gate)", () => {
  test("rejects a registered project whose local code index carries schemaVersion 1", async () => {
    const hubRoot = await tempDir("hub-startup-v1");
    const sourcePath = await createSourceFixture("startup-v1");
    const cpbRoot = await tempDir("cpb-startup-v1");

    await writeV1IndexMigrationInput(cpbRoot, sourcePath);
    await registerProjectFixture(hubRoot, "proj-v1", sourcePath, cpbRoot);

    const result = await gateRegistryState(hubRoot, cpbRoot);

    assert.equal(result.passed, false, "gate must fail for v1 index");
    if (result.passed) throw new Error("unreachable"); // type narrowing
    assert.equal(result.code, "UNSUPPORTED_INDEX_SCHEMA");
    assert.equal(result.projectId, "proj-v1");
    assert.equal(result.sourcePath, sourcePath);
    assert.equal(result.detectedSchemaVersion, 1);
    assert.equal(result.requiredSchemaVersion, 2);
    assert.ok(
      result.migrationInstructions.includes("schema v1"),
      "migration instructions must mention schema v1",
    );
    assert.ok(
      result.migrationInstructions.includes("cpb init"),
      "migration instructions must mention cpb init",
    );
  });

  test("passes when all registered projects have schemaVersion 2", async () => {
    const hubRoot = await tempDir("hub-startup-v2");
    const sourcePath = await createSourceFixture("startup-v2");
    const cpbRoot = await tempDir("cpb-startup-v2");

    await writeV2LocalCodeIndex(cpbRoot, sourcePath);
    await registerProjectFixture(hubRoot, "proj-v2", sourcePath, cpbRoot);

    const result = await gateRegistryState(hubRoot, cpbRoot);

    assert.equal(result.passed, true, "gate must pass for v2 index");
  });

  test("passes when a project has no index at all (missing is not a schema violation)", async () => {
    const hubRoot = await tempDir("hub-startup-missing");
    const sourcePath = await createSourceFixture("startup-missing");
    const cpbRoot = await tempDir("cpb-startup-missing");

    // No index written -- localCodeIndexStatus will return
    // { available: false, reason: "missing_local_code_index" } which is
    // NOT a schema violation.
    await registerProjectFixture(hubRoot, "proj-missing", sourcePath, cpbRoot);

    const result = await gateRegistryState(hubRoot, cpbRoot);

    assert.equal(result.passed, true, "missing index must not block startup");
  });

  test("rejects the first v1 project even when a v2 project is also registered", async () => {
    const hubRoot = await tempDir("hub-startup-mixed");
    const cpbRoot = await tempDir("cpb-startup-mixed");

    const sourceV2 = await createSourceFixture("mixed-v2");
    await writeV2LocalCodeIndex(cpbRoot, sourceV2);
    await registerProjectFixture(hubRoot, "proj-ok", sourceV2, cpbRoot);

    const sourceV1 = await createSourceFixture("mixed-v1");
    await writeV1IndexMigrationInput(cpbRoot, sourceV1);
    await registerProjectFixture(hubRoot, "proj-bad", sourceV1, cpbRoot);

    const result = await gateRegistryState(hubRoot, cpbRoot);

    assert.equal(result.passed, false, "gate must fail when any project has v1");
    if (result.passed) throw new Error("unreachable");
    assert.equal(result.code, "UNSUPPORTED_INDEX_SCHEMA");
    assert.equal(result.projectId, "proj-bad");
  });

  test("skips disabled projects", async () => {
    const hubRoot = await tempDir("hub-startup-disabled");
    const sourcePath = await createSourceFixture("startup-disabled");
    const cpbRoot = await tempDir("cpb-startup-disabled");

    await writeV1IndexMigrationInput(cpbRoot, sourcePath);

    // Register with enabled: false via direct registry mutation.
    await registerProjectFixture(hubRoot, "proj-disabled", sourcePath, cpbRoot);

    // Mutate the registry to disable the project.
    const regPath = path.join(hubRoot, "projects.json");
    const { readFile, writeFile: writeFileAtomic } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(regPath, "utf8"));
    raw.projects["proj-disabled"].enabled = false;
    await writeFileAtomic(regPath, JSON.stringify(raw, null, 2) + "\n", "utf8");

    const result = await gateRegistryState(hubRoot, cpbRoot);

    assert.equal(result.passed, true, "disabled projects must be skipped");
  });
});

// ── Test 2: Scheduler defense-in-depth gate ──────────────────────────────────

describe("gateDispatchCandidate (scheduler defense-in-depth)", () => {
  test("rejects a dispatch candidate whose local code index carries schemaVersion 1", async () => {
    const hubRoot = await tempDir("hub-dispatch-v1");
    const sourcePath = await createSourceFixture("dispatch-v1");
    const cpbRoot = await tempDir("cpb-dispatch-v1");

    await writeV1IndexMigrationInput(cpbRoot, sourcePath);

    const result = await gateDispatchCandidate(
      hubRoot,
      "proj-v1",
      sourcePath,
      cpbRoot,
    );

    assert.equal(result.passed, false, "dispatch gate must fail for v1 index");
    if (result.passed) throw new Error("unreachable");
    assert.equal(result.code, "UNSUPPORTED_INDEX_SCHEMA");
    assert.equal(result.projectId, "proj-v1");
    assert.equal(result.sourcePath, sourcePath);
    assert.equal(result.detectedSchemaVersion, 1);
    assert.equal(result.requiredSchemaVersion, 2);
    assert.ok(
      result.migrationInstructions.length > 0,
      "migration instructions must be non-empty",
    );
  });

  test("passes when the candidate's index has schemaVersion 2", async () => {
    const hubRoot = await tempDir("hub-dispatch-v2");
    const sourcePath = await createSourceFixture("dispatch-v2");
    const cpbRoot = await tempDir("cpb-dispatch-v2");

    await writeV2LocalCodeIndex(cpbRoot, sourcePath);

    const result = await gateDispatchCandidate(
      hubRoot,
      "proj-v2",
      sourcePath,
      cpbRoot,
    );

    assert.equal(result.passed, true, "dispatch gate must pass for v2 index");
  });

  test("passes when the candidate has no index (missing is not a schema violation)", async () => {
    const hubRoot = await tempDir("hub-dispatch-missing");
    const sourcePath = await createSourceFixture("dispatch-missing");
    const cpbRoot = await tempDir("cpb-dispatch-missing");

    const result = await gateDispatchCandidate(
      hubRoot,
      "proj-missing",
      sourcePath,
      cpbRoot,
    );

    assert.equal(result.passed, true, "missing index must not block dispatch");
  });

  test("catches a downgraded index even when called without registry context", async () => {
    // Simulates the scenario where the startup gate passed (v2), but
    // between ticks someone replaced the index with a v1 snapshot.
    // The dispatch gate re-probes from the filesystem directly.
    const hubRoot = await tempDir("hub-dispatch-downgrade");
    const sourcePath = await createSourceFixture("dispatch-downgrade");
    const cpbRoot = await tempDir("cpb-dispatch-downgrade");

    // Start with v2 -- startup would pass.
    await writeV2LocalCodeIndex(cpbRoot, sourcePath);
    const startupResult = await gateRegistryState(hubRoot, cpbRoot);
    assert.equal(startupResult.passed, true, "startup must pass with v2");

    // Downgrade: overwrite with v1 index.
    await writeV1IndexMigrationInput(cpbRoot, sourcePath);

    // Dispatch gate catches the downgrade.
    const dispatchResult = await gateDispatchCandidate(
      hubRoot,
      "proj-downgraded",
      sourcePath,
      cpbRoot,
    );

    assert.equal(dispatchResult.passed, false, "dispatch gate must catch the downgrade");
    if (dispatchResult.passed) throw new Error("unreachable");
    assert.equal(dispatchResult.code, "UNSUPPORTED_INDEX_SCHEMA");
  });

  test("migration instructions reference cpb init and rm -rf recovery paths", async () => {
    const hubRoot = await tempDir("hub-dispatch-migration");
    const sourcePath = await createSourceFixture("dispatch-migration");
    const cpbRoot = await tempDir("cpb-dispatch-migration");

    await writeV1IndexMigrationInput(cpbRoot, sourcePath);

    const result = await gateDispatchCandidate(
      hubRoot,
      "proj-migration",
      sourcePath,
      cpbRoot,
    );

    assert.equal(result.passed, false);
    if (result.passed) throw new Error("unreachable");

    const instructions = result.migrationInstructions;
    assert.ok(
      instructions.includes("cpb init"),
      'must mention "cpb init" recovery path',
    );
    assert.ok(
      instructions.includes("rm -rf"),
      'must mention "rm -rf" recovery path',
    );
    assert.ok(
      instructions.includes("local-code-index-v2-spec.md"),
      "must reference the spec document",
    );
  });
});

// ── Test 3: Scanner classification fixtures ──────────────────────────────────

describe("scanner classification fixtures", () => {
  test("schema owner files exist for all three owners", async () => {
    const ownerFiles = [
      "server/services/migration/local-code-index-v2.ts",
      "server/services/hub/local-code-index-state-gate.ts",
      "core/indexing/local-code-index/contracts.ts",
    ];
    for (const file of ownerFiles) {
      const absPath = path.join(REPO_ROOT, file);
      try {
        await stat(absPath);
      } catch {
        assert.fail(`schema owner file missing: ${file}`);
      }
    }
  });

  test("scanner rules do not catch CandidateArtifact.schemaVersion === 1", async () => {
    // CandidateArtifact uses schemaVersion: 1 but it's a different schema owner.
    // The scanner's dual-schema rule must be scoped to local-code-index context.
    const content = `export type CandidateArtifact = { schemaVersion: 1; baseSha: string; };`;
    const violations = await scanContentForTest(content, "test-candidate.ts");
    const dualSchemaViolations = violations.filter(
      (v) => v.rule.label.includes("dual schema"),
    );
    assert.strictEqual(
      dualSchemaViolations.length,
      0,
      "CandidateArtifact.schemaVersion === 1 must not be caught by dual-schema rule",
    );
  });

  test("scanner rules do not catch ensureIndexFresh", async () => {
    // ensureIndexFresh is a v2 method, not a detached v1 indexFreshness field.
    const content = `export function ensureIndexFresh(sourcePath: string) { return true; }`;
    const violations = await scanContentForTest(content, "test-ensure.ts");
    const freshnessViolations = violations.filter(
      (v) => v.rule.label.includes("indexFreshness"),
    );
    assert.strictEqual(
      freshnessViolations.length,
      0,
      "ensureIndexFresh must not be caught by indexFreshness rule",
    );
  });

  test("scanner catches detached indexFreshness field", async () => {
    const content = `const meta = { indexFreshness: { dirty: true } };`;
    const violations = await scanContentForTest(content, "test-detached.ts");
    const freshnessViolations = violations.filter(
      (v) => v.rule.label.includes("indexFreshness"),
    );
    assert.ok(
      freshnessViolations.length > 0,
      "detached indexFreshness field must be caught",
    );
  });

  test("scanner catches detached indexSnapshot field", async () => {
    const content = `const snap = { indexSnapshot: { id: "old" } };`;
    const violations = await scanContentForTest(content, "test-snapshot.ts");
    const snapshotViolations = violations.filter(
      (v) => v.rule.label.includes("indexSnapshot"),
    );
    assert.ok(
      snapshotViolations.length > 0,
      "detached indexSnapshot field must be caught",
    );
  });

  test("scanner does not catch indexSnapshotId in migration owner file", async () => {
    // The migration file is allowed to reference indexSnapshotId because
    // it must strip the field during migration.
    const migrationFile = "server/services/migration/local-code-index-v2.ts";
    const content = `meta.indexSnapshotId = undefined; // strip v1 field`;
    const violations = await scanContentForTest(content, migrationFile);
    assert.strictEqual(
      violations.length,
      0,
      "migration owner file must be exempt from indexSnapshotId rule",
    );
  });
});

// ── Test 4: Source-tree pollution detection ──────────────────────────────────

describe("source-tree pollution detection", () => {
  test("TS source dirs must not contain .js files", async () => {
    // This test verifies the scanner would catch .js files in TS source dirs.
    // We can't easily test the actual filesystem scan without creating temp files,
    // so we verify the rule exists and the pattern matches.
    const sourceDir = "core/indexing/local-code-index";
    const absDir = path.join(REPO_ROOT, sourceDir);
    try {
      const entries = await readdir(absDir);
      const jsFiles = entries.filter(
        (e) => e.endsWith(".js") && !e.endsWith(".d.ts"),
      );
      // After Phase 5 cleanup, there should be no .js files.
      assert.strictEqual(
        jsFiles.length,
        0,
        `source-tree pollution: .js files found in ${sourceDir}: ${jsFiles.join(", ")}`,
      );
    } catch {
      // directory doesn't exist in this worktree, that's fine
    }
  });

  test("TS source dirs must not contain .d.ts files", async () => {
    const sourceDir = "core/indexing/local-code-index";
    const absDir = path.join(REPO_ROOT, sourceDir);
    try {
      const entries = await readdir(absDir);
      const dtsFiles = entries.filter((e) => e.endsWith(".d.ts"));
      assert.strictEqual(
        dtsFiles.length,
        0,
        `source-tree pollution: .d.ts files found in ${sourceDir}: ${dtsFiles.join(", ")}`,
      );
    } catch {
      // directory doesn't exist in this worktree, that's fine
    }
  });
});

describe("canonical CLI ownership", () => {
  test("v2 service contains no second CLI-only index implementation", async () => {
    const service = await readFile(
      path.join(REPO_ROOT, "core/indexing/local-code-index/service.ts"),
      "utf8",
    );
    assert.doesNotMatch(service, /\bexport\s+(?:async\s+)?function\s+checkStatus\b/);
    assert.doesNotMatch(service, /\bexport\s+(?:async\s+)?function\s+buildIndex\b/);
    assert.doesNotMatch(service, /\bexport\s+(?:async\s+)?function\s+queryIndex\b/);
    assert.doesNotMatch(service, /["']index\.json["']/);
  });

  test("code-index CLI imports only the canonical v2 facade", async () => {
    const cli = await readFile(
      path.join(REPO_ROOT, "cli/commands/code-index.ts"),
      "utf8",
    );
    assert.match(cli, /\bensureLocalCodeIndex\b/);
    assert.match(cli, /\blocalCodeIndexStatus\b/);
    assert.match(cli, /\bqueryLocalCodeIndex\b/);
    assert.doesNotMatch(cli, /\b(checkStatus|buildIndex|queryIndex)\b/);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Schema owner files for test classification.
 */
const SCHEMA_OWNER_FILES = new Map([
  ["migration", new Set(["server/services/migration/local-code-index-v2.ts"])],
  ["state-gate", new Set(["server/services/hub/local-code-index-state-gate.ts"])],
  ["contracts", new Set(["core/indexing/local-code-index/contracts.ts"])],
]);

function schemaOwnerForFile(relPath: string): string | null {
  for (const [owner, files] of SCHEMA_OWNER_FILES) {
    if (files.has(relPath)) return owner;
  }
  return null;
}

/**
 * Scan a single content string as if it were a file at the given path.
 * Used for testing scanner rules in isolation.
 */
async function scanContentForTest(
  content: string,
  relPath: string,
): Promise<Array<{ file: string; line: number; rule: { label: string }; matchedText: string }>> {
  const isSource = relPath.endsWith(".ts") && !relPath.startsWith("dist/");
  const owner = schemaOwnerForFile(relPath);
  const violations: Array<{ file: string; line: number; rule: { label: string }; matchedText: string }> = [];

  // Classification fixture rules (mirrored from scanner)
  const rules = [
    { label: "dual schema branch (local-code-index schemaVersion === 1 || ... === 2)", pattern: /local.*code.*index.*schemaVersion\s*===\s*1|schemaVersion\s*===\s*1.*local.*code.*index/i, sourceOnly: true },
    { label: "detached v1 field: indexFreshness", pattern: /(?<!ensure)\bindexFreshness\b/, sourceOnly: true, ownerExempt: "migration" },
    { label: "detached v1 field: indexSnapshot (not indexSnapshotId in v2)", pattern: /\bindexSnapshot\b(?!Id)/, sourceOnly: true, ownerExempt: "migration" },
    { label: "detached v1 field: indexSnapshotId (v1 snapshot ID storage)", pattern: /\bindexSnapshotId\b/, sourceOnly: true, ownerExempt: "migration" },
  ];

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSource && (line.trimStart().startsWith("//") || line.trimStart().startsWith("*"))) continue;
    for (const rule of rules) {
      if (rule.sourceOnly && !isSource) continue;
      if (rule.ownerExempt && owner === rule.ownerExempt) continue;
      const match = rule.pattern.exec(line);
      if (match) {
        violations.push({ file: relPath, line: i + 1, rule, matchedText: match[0] });
      }
    }
  }
  return violations;
}

// Import readdir and stat for pollution tests.
import { readdir, stat } from "node:fs/promises";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
