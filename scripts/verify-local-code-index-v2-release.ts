#!/usr/bin/env node
/**
 * verify-local-code-index-v2-release.ts
 *
 * Release gate that scans the repository for leftover v1 local-code-index
 * references before shipping the v2 release.  The script checks six surfaces:
 *
 *   1. TypeScript source  -- v1 symbols, types, imports, dual-schema branches
 *   2. Emitted dist/      -- v1 imports surviving compilation
 *   3. Persisted-state    -- fixtures / schemas carrying v1 fields
 *   4. CLI registrations  -- old command names or stale help text
 *   5. Source-tree pollution -- accidental .js, .d.ts, .map in TS source dirs
 *   6. Schemas / fixtures -- schema files and classification fixtures
 *
 * Classification by contract owner:
 *   - migration:     server/services/migration/local-code-index-v2.ts
 *   - state-gate:    server/services/hub/local-code-index-state-gate.ts
 *   - contracts:     core/indexing/local-code-index/contracts.ts (LocalCodeIndexRef)
 *
 * Reject patterns:
 *   - LOCAL_CODE_INDEX_SCHEMA_VERSION=1
 *   - checkLocalCodeIndexReady, readLocalCodeIndexFiles, readLocalCodeIndexSnapshot
 *   - indexFile in readiness contexts
 *   - schema-1 readers/writers
 *   - dual schema branches (scoped to local-code-index context only)
 *   - detached v1 fields (indexFreshness, indexSnapshot)
 *
 * Allow patterns:
 *   - Named migration input fixtures (tests/local-code-index-v2-migration*.test.ts)
 *   - Offline migration recognizer (server/services/migration/local-code-index-v2.ts)
 *   - Reject-only state gate (server/services/hub/local-code-index-state-gate.ts)
 *   - CandidateArtifact.schemaVersion === 1 (different schema owner)
 *   - ensureIndexFresh (v2 method, not a detached v1 field)
 *   - indexSnapshotId in v2 ref context (LocalCodeIndexRef.snapshotId)
 *
 * Run:
 *   npx tsx scripts/verify-local-code-index-v2-release.ts
 *   # or after build:
 *   node dist/scripts/verify-local-code-index-v2-release.js
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { verifyArtifact } from "./verify-local-code-index-v2-benchmark.js";

// ── Constants ────────────────────────────────────────────────────────────────

// When compiled, this file lives at dist/scripts/; resolve to repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";
const WARN = "\x1b[0;33mWARN\x1b[0m";

// ── Schema owner classification ──────────────────────────────────────────────

/**
 * The three contract owners for local-code-index schema fields.
 * Each owner defines which files are allowed to reference v1 symbols.
 */
type SchemaOwner = "migration" | "state-gate" | "contracts" | "repository-snapshot";

/**
 * Files that belong to each schema owner.  These files are allowed to
 * reference v1 symbols because they implement the migration, rejection,
 * or contract definition logic.
 */
const SCHEMA_OWNER_FILES: ReadonlyMap<SchemaOwner, ReadonlySet<string>> = new Map([
  ["migration", new Set([
    "server/services/migration/local-code-index-v2.ts",
  ])],
  ["state-gate", new Set([
    "server/services/hub/local-code-index-state-gate.ts",
  ])],
  ["contracts", new Set([
    "core/indexing/local-code-index/contracts.ts",
  ])],
  // Repository-snapshot contract: files that use indexSnapshotId, indexSnapshot,
  // and indexFreshness as part of the repository-snapshot contract (not local-index v1).
  // These fields are actively used by the scheduler, dispatch, event system, etc.
  ["repository-snapshot", new Set([
    "server/orchestrator/scheduler.ts",
    "server/services/dispatch/dispatch.ts",
    "server/services/event/event-materializer.ts",
    "server/services/event/event-types.ts",
    "server/services/hub/hub-queue.ts",
    "server/services/hub/hub-registry.ts",
    "server/services/hub/worker-state-broker.ts",
    "server/services/infra.ts",
    "server/services/job/job-store.ts",
    "tests/checklist-decompose-integration.test.ts",
    "tests/queue-orchestrator.test.ts",
  ])],
]);

/**
 * Test files that are allowed to contain v1 symbols because they are named
 * migration input fixtures or characterization tests that document v1 behavior
 * as a baseline for the migration.
 */
const ALLOWED_MIGRATION_TEST_PATTERNS: ReadonlyArray<RegExp> = [
  /^tests\/local-code-index-v2-migration.*\.test\.ts$/,
  /^tests\/local-code-index-v2-release-scan\.test\.ts$/,
  /^tests\/local-code-index-caller-characterization\.test\.ts$/,
  /^tests\/local-code-index-contract\.test\.ts$/,
];

/**
 * The two v1 module files themselves -- they exist as stubs and will be
 * deleted in Phase 10.  We exclude them from the scan because they *are*
 * the v1 code; the scan checks that nothing else imports them.
 * Both the source and emitted dist/ counterparts are excluded.
 */
const V1_SOURCE_FILES: ReadonlySet<string> = new Set([
  "server/services/local-code-index.ts",
  "core/indexing/local-code-index-snapshot.ts",
]);

/**
 * Additional files that are exempt from scanning:
 * - The v2 implementation plan (documents v1 for context, not production code)
 * - This scanner script and its compiled output (contains v1 symbols as rule text)
 */
const EXEMPT_FILES: ReadonlySet<string> = new Set([
  "scripts/workflows/local-code-index-v2.ts",
  "scripts/verify-local-code-index-v2-release.ts",
]);

// ── Rejection rules ──────────────────────────────────────────────────────────

type RejectionRule = {
  label: string;
  /** Regex that matches a forbidden pattern in a single line. */
  pattern: RegExp;
  /** If true, only match in .ts source files. If false, match everywhere. */
  sourceOnly?: boolean;
  /** If true, only match in dist/ emitted files. */
  distOnly?: boolean;
  /**
   * Schema owner that is allowed to contain this pattern.
   * If set, files belonging to this owner are exempt from this rule.
   */
  ownerExempt?: SchemaOwner;
  /**
   * If true, also exempt files belonging to the "repository-snapshot" owner.
   * Used for fields like indexFreshness, indexSnapshot, indexSnapshotId
   * that are repository-snapshot contract fields, not local-index v1 state.
   */
  repoSnapshotExempt?: boolean;
};

/**
 * These rules are applied line-by-line against every scanned file (unless
 * constrained by sourceOnly/distOnly).  A match produces a violation unless
 * the file is in an allow-list or exempt by schema owner.
 *
 * Rules are scoped by owning type to avoid false positives:
 * - CandidateArtifact.schemaVersion === 1 is NOT a local-code-index v1 reference
 * - ensureIndexFresh is a v2 method, NOT a detached v1 indexFreshness field
 * - indexSnapshotId in LocalCodeIndexRef context is v2, NOT v1 storage
 */
const REJECTION_RULES: ReadonlyArray<RejectionRule> = [
  // ── Env var set to v1 ──────────────────────────────────────────────────
  {
    label: "LOCAL_CODE_INDEX_SCHEMA_VERSION=1",
    pattern: /LOCAL_CODE_INDEX_SCHEMA_VERSION\s*[=:]\s*["']?1["']?/,
  },

  // ── v1 function symbols ────────────────────────────────────────────────
  {
    label: "checkLocalCodeIndexReady",
    pattern: /\bcheckLocalCodeIndexReady\b/,
  },
  {
    label: "readLocalCodeIndexFiles",
    pattern: /\breadLocalCodeIndexFiles\b/,
  },
  {
    label: "readLocalCodeIndexSnapshot",
    pattern: /\breadLocalCodeIndexSnapshot\b/,
  },

  // ── v1 type symbols ────────────────────────────────────────────────────
  {
    label: "LocalCodeIndexSnapshot type (v1)",
    pattern: /\bLocalCodeIndexSnapshot\b/,
    sourceOnly: true,
  },
  {
    label: "LocalCodeIndexFile type (v1)",
    pattern: /\bLocalCodeIndexFile\b(?!Entry)/,
    sourceOnly: true,
  },

  // ── v1 readiness pattern: indexFile in readiness context ───────────────
  // Matches patterns like: readiness.indexFile, readiness: { indexFile },
  // localCodeIndexReadiness.indexFile, etc.  Does NOT match the job-store
  // indexFile which is a different concept (jobs-index.json path).
  {
    label: "indexFile in readiness context",
    pattern: /\b(localCodeIndex|readiness|Ready).*\bindexFile\b/i,
    sourceOnly: true,
  },

  // ── v1 imports from v1 modules ─────────────────────────────────────────
  {
    label: "import from server/services/local-code-index (v1 module)",
    pattern: /from\s+["'].*server\/services\/local-code-index(?:\.js)?["']/,
    sourceOnly: true,
  },
  {
    label: "import from local-code-index-snapshot (v1 module)",
    pattern: /from\s+["'].*local-code-index-snapshot(?:\.js)?["']/,
    sourceOnly: true,
  },

  // ── v1 imports in emitted dist/ ────────────────────────────────────────
  {
    label: "dist/ import of v1 local-code-index module",
    pattern: /require\(.*local-code-index(?:\.js)?["']\)|from\s+["'].*local-code-index(?:\.js)?["']/,
    distOnly: true,
  },

  // ── Dual schema branches: code that handles both v1 and v2 ─────────────
  // Scoped to local-code-index context only.  CandidateArtifact.schemaVersion
  // === 1 is a different schema owner and must NOT be caught.
  {
    label: "dual schema branch (local-code-index schemaVersion === 1 || ... === 2)",
    pattern: /local.*code.*index.*schemaVersion\s*===\s*1|schemaVersion\s*===\s*1.*local.*code.*index/i,
    sourceOnly: true,
  },

  // ── Detached v1 fields in production code ──────────────────────────────
  // indexFreshness: only match as a standalone field name, NOT ensureIndexFresh
  // which is a v2 method.  The negative lookbehind excludes "ensure" prefix.
  {
    label: "detached v1 field: indexFreshness",
    pattern: /(?<!ensure)\bindexFreshness\b/,
    sourceOnly: true,
    ownerExempt: "migration",
    repoSnapshotExempt: true,
  },
  // indexSnapshot: detached v1 snapshot copy (not indexSnapshotId in v2 ref).
  // Only match when NOT in a LocalCodeIndexRef or snapshotId context.
  {
    label: "detached v1 field: indexSnapshot (not indexSnapshotId in v2)",
    pattern: /\bindexSnapshot\b(?!Id)/,
    sourceOnly: true,
    ownerExempt: "migration",
    repoSnapshotExempt: true,
  },
  // indexSnapshotId: v1 snapshot ID storage.  Allowed in migration owner
  // because it must reference the field to strip it.
  {
    label: "detached v1 field: indexSnapshotId (v1 snapshot ID storage)",
    pattern: /\bindexSnapshotId\b/,
    sourceOnly: true,
    ownerExempt: "migration",
    repoSnapshotExempt: true,
  },
];

// ── Source-tree pollution patterns ───────────────────────────────────────────

/**
 * TypeScript source directories that must NOT contain compiled .js, .d.ts,
 * or .map files.  These are accidental artifacts from a misconfigured build.
 */
const TS_SOURCE_DIRS: ReadonlyArray<string> = [
  "core/indexing/local-code-index",
];

// ── File scanning ────────────────────────────────────────────────────────────

type Violation = {
  file: string;
  line: number;
  rule: RejectionRule | { label: string; pattern: RegExp };
  matchedText: string;
};

/**
 * Recursively collect all files under `dir` that match `extensions`.
 * Skips node_modules, .git, and dist-tests (only dist/ is scanned for
 * emitted-code checks).
 */
async function collectFiles(
  dir: string,
  extensions: ReadonlySet<string>,
  skipDirs: ReadonlySet<string> = new Set(["node_modules", ".git", ".claude"]),
): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(REPO_ROOT, fullPath);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      results.push(...await collectFiles(fullPath, extensions, skipDirs));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.has(ext)) {
        results.push(relPath);
      }
    }
  }
  return results;
}

function isAllowedFile(relPath: string): boolean {
  // V1 source files themselves are excluded (they ARE the v1 code).
  if (V1_SOURCE_FILES.has(relPath)) return true;

  // Also exclude dist/ counterparts of v1 source files.
  if (relPath.startsWith("dist/")) {
    const sourceEquiv = relPath.slice("dist/".length).replace(/\.js$/, ".ts");
    if (V1_SOURCE_FILES.has(sourceEquiv)) return true;
  }

  // Exempt files (scanner itself, implementation plan).
  if (EXEMPT_FILES.has(relPath)) return true;
  if (relPath.startsWith("dist/") && EXEMPT_FILES.has(relPath.slice("dist/".length).replace(/\.js$/, ".ts"))) {
    return true;
  }

  // Migration / state-gate / contracts files are allowed (schema owners).
  for (const ownerFiles of SCHEMA_OWNER_FILES.values()) {
    if (ownerFiles.has(relPath)) return true;
  }

  // Migration test fixtures are allowed.
  for (const pattern of ALLOWED_MIGRATION_TEST_PATTERNS) {
    if (pattern.test(relPath)) return true;
  }

  return false;
}

/**
 * Determine which schema owner (if any) a file belongs to.
 */
function schemaOwnerForFile(relPath: string): SchemaOwner | null {
  for (const [owner, files] of SCHEMA_OWNER_FILES) {
    if (files.has(relPath)) return owner;
  }
  return null;
}

function shouldApplyRule(rule: RejectionRule, isSource: boolean, isDist: boolean): boolean {
  if (rule.sourceOnly && !isSource) return false;
  if (rule.distOnly && !isDist) return false;
  return true;
}

async function scanFile(relPath: string): Promise<Violation[]> {
  const absPath = path.join(REPO_ROOT, relPath);
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return []; // unreadable file, skip
  }

  const isSource = relPath.endsWith(".ts") && !relPath.startsWith("dist/");
  const isDist = relPath.startsWith("dist/") || relPath.startsWith("dist-tests/");
  const owner = schemaOwnerForFile(relPath);
  const violations: Violation[] = [];
  const lines = content.split("\n");

  // The canonical v2 facade must not grow a second CLI-only index
  // implementation. These checks are deliberately path-scoped so unrelated
  // helpers named buildIndex in tests or other domains are not rejected.
  if (relPath === "core/indexing/local-code-index/service.ts") {
    const forbiddenServicePatterns: ReadonlyArray<RejectionRule> = [
      {
        label: "noncanonical CLI status helper in v2 service",
        pattern: /\bexport\s+(?:async\s+)?function\s+checkStatus\b/,
      },
      {
        label: "noncanonical CLI build helper in v2 service",
        pattern: /\bexport\s+(?:async\s+)?function\s+buildIndex\b/,
      },
      {
        label: "noncanonical CLI query helper in v2 service",
        pattern: /\bexport\s+(?:async\s+)?function\s+queryIndex\b/,
      },
      {
        label: "legacy monolithic index.json path in v2 service",
        pattern: /["']index\.json["']/,
      },
    ];
    for (let i = 0; i < lines.length; i++) {
      for (const rule of forbiddenServicePatterns) {
        const match = rule.pattern.exec(lines[i]!);
        if (match) {
          violations.push({
            file: relPath,
            line: i + 1,
            rule,
            matchedText: match[0],
          });
        }
      }
    }
  }

  if (relPath === "cli/commands/code-index.ts") {
    const rule: RejectionRule = {
      label: "CLI imports noncanonical local-index helper",
      pattern: /\b(checkStatus|buildIndex|queryIndex)\b/,
    };
    for (let i = 0; i < lines.length; i++) {
      const match = rule.pattern.exec(lines[i]!);
      if (match) {
        violations.push({
          file: relPath,
          line: i + 1,
          rule,
          matchedText: match[0],
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and blank lines for source scans (but not dist, where
    // comments are stripped by tsc).
    if (isSource && (line.trimStart().startsWith("//") || line.trimStart().startsWith("*") || line.trimStart().startsWith("/*"))) {
      continue;
    }

    for (const rule of REJECTION_RULES) {
      if (!shouldApplyRule(rule, isSource, isDist)) continue;
      // Skip if the file belongs to the exempt schema owner for this rule.
      if (rule.ownerExempt && owner === rule.ownerExempt) continue;
      // Skip if the rule exempts repository-snapshot owner files.
      if (rule.repoSnapshotExempt && owner === "repository-snapshot") continue;
      const match = rule.pattern.exec(line);
      if (match) {
        violations.push({
          file: relPath,
          line: i + 1,
          rule,
          matchedText: match[0],
        });
      }
    }
  }

  return violations;
}

// ── CLI registration check ───────────────────────────────────────────────────

async function checkCliRegistrations(): Promise<Violation[]> {
  const violations: Violation[] = [];
  const cpbPath = path.join(REPO_ROOT, "cli", "cpb.ts");

  let content: string;
  try {
    content = await readFile(cpbPath, "utf8");
  } catch {
    return []; // file not found, skip
  }

  // Check for old command registrations that reference v1 directly.
  // The v2 CLI uses "code-index" and "migrate" commands.  Old commands
  // like "index" (without "code-" prefix) or "check" subcommand are v1.
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Old "check" subcommand for local code index
    if (/["']check["'].*local.*code.*index/i.test(line) ||
        /local.*code.*index.*["']check["']/i.test(line)) {
      violations.push({
        file: "cli/cpb.ts",
        line: i + 1,
        rule: { label: "old CLI subcommand: check", pattern: /check/ },
        matchedText: line.trim(),
      });
    }
  }

  return violations;
}

// ── Source-tree pollution check ──────────────────────────────────────────────

async function checkSourceTreePollution(): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const sourceDir of TS_SOURCE_DIRS) {
    const absDir = path.join(REPO_ROOT, sourceDir);
    try {
      await stat(absDir);
    } catch {
      continue; // directory doesn't exist, skip
    }

    const pollutedExtensions = new Set([".js", ".d.ts", ".js.map", ".d.ts.map"]);
    const allFiles = await collectFiles(absDir, new Set([".js", ".map"]), new Set(["node_modules"]));

    for (const relPath of allFiles) {
      const ext = path.extname(relPath);
      const basename = path.basename(relPath);

      // Check for .js files (compiled output in source dir)
      if (ext === ".js" && !relPath.includes(".d.")) {
        // Verify it's not a .d.ts disguised as .js
        if (!basename.endsWith(".d.ts")) {
          violations.push({
            file: relPath,
            line: 0,
            rule: { label: "source-tree pollution: .js in TS source dir", pattern: /\.js$/ },
            matchedText: basename,
          });
        }
      }

      // Check for .d.ts files (declaration output in source dir)
      if (basename.endsWith(".d.ts")) {
        violations.push({
          file: relPath,
          line: 0,
          rule: { label: "source-tree pollution: .d.ts in TS source dir", pattern: /\.d\.ts$/ },
          matchedText: basename,
        });
      }

      // Check for .map files (source maps in source dir)
      if (ext === ".map") {
        violations.push({
          file: relPath,
          line: 0,
          rule: { label: "source-tree pollution: .map in TS source dir", pattern: /\.map$/ },
          matchedText: basename,
        });
      }
    }
  }

  return violations;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Scanning for leftover v1 local-code-index references...\n");

  const allViolations: Violation[] = [];

  // ── 1. Scan TypeScript source ──────────────────────────────────────────
  console.log("  [1/7] Scanning TypeScript source for v1 references...");
  const tsFiles = await collectFiles(
    REPO_ROOT,
    new Set([".ts"]),
    new Set(["node_modules", ".git", ".claude", "dist", "dist-tests"]),
  );
  for (const relPath of tsFiles) {
    if (isAllowedFile(relPath)) continue;
    const violations = await scanFile(relPath);
    allViolations.push(...violations);
  }

  // ── 2. Scan emitted dist/ for v1 imports ───────────────────────────────
  console.log("  [2/7] Scanning emitted dist/ for v1 imports...");
  const distDir = path.join(REPO_ROOT, "dist");
  try {
    await stat(distDir);
    const distFiles = await collectFiles(
      distDir,
      new Set([".js", ".mjs"]),
      new Set(["node_modules"]),
    );
    for (const relPath of distFiles) {
      if (isAllowedFile(relPath)) continue;
      const violations = await scanFile(relPath);
      allViolations.push(...violations);
    }
  } catch {
    console.log(`  ${WARN} dist/ directory not found -- skipping emitted-code scan.`);
    console.log("         Run `npm run build` first for full coverage.\n");
  }

  // ── 3. Scan persisted-state schemas/fixtures ───────────────────────────
  console.log("  [3/7] Scanning persisted-state fixtures for v1 fields...");
  const fixtureDirs = ["tests/fixtures", "tests/integration"];
  for (const fixtureDir of fixtureDirs) {
    const absDir = path.join(REPO_ROOT, fixtureDir);
    try {
      await stat(absDir);
      const fixtureFiles = await collectFiles(
        absDir,
        new Set([".ts", ".js", ".json"]),
        new Set(["node_modules"]),
      );
      for (const relPath of fixtureFiles) {
        if (isAllowedFile(relPath)) continue;
        const violations = await scanFile(relPath);
        allViolations.push(...violations);
      }
    } catch {
      // directory doesn't exist, skip
    }
  }

  // ── 4. CLI registrations ───────────────────────────────────────────────
  console.log("  [4/7] Checking CLI registrations for old commands...");
  const cliViolations = await checkCliRegistrations();
  allViolations.push(...cliViolations);

  // ── 5. Source-tree pollution ────────────────────────────────────────────
  console.log("  [5/7] Checking source-tree pollution (.js, .d.ts, .map in TS dirs)...");
  const pollutionViolations = await checkSourceTreePollution();
  allViolations.push(...pollutionViolations);

  // ── 6. Schema / fixture classification ─────────────────────────────────
  console.log("  [6/7] Verifying schema owner classification fixtures...");
  // Verify that the three schema owner files exist.
  for (const [owner, files] of SCHEMA_OWNER_FILES) {
    for (const file of files) {
      const absPath = path.join(REPO_ROOT, file);
      try {
        await stat(absPath);
      } catch {
        allViolations.push({
          file,
          line: 0,
          rule: { label: `missing schema owner file (${owner})`, pattern: /./ },
          matchedText: file,
        });
      }
    }
  }

  // ── 7. Independently verify benchmark evidence ────────────────────────
  console.log("  [7/7] Verifying canonical benchmark evidence...");
  const benchmarkPath = path.join(
    REPO_ROOT,
    "artifacts",
    "bench",
    "local-code-index-v2.json",
  );
  try {
    const artifact = JSON.parse(await readFile(benchmarkPath, "utf8")) as unknown;
    for (const failure of verifyArtifact(artifact)) {
      allViolations.push({
        file: "artifacts/bench/local-code-index-v2.json",
        line: 0,
        rule: { label: "invalid benchmark evidence", pattern: /./ },
        matchedText: failure,
      });
    }
  } catch (error) {
    allViolations.push({
      file: "artifacts/bench/local-code-index-v2.json",
      line: 0,
      rule: { label: "missing or unreadable benchmark evidence", pattern: /./ },
      matchedText: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log("");

  if (allViolations.length === 0) {
    console.log(`${PASS} All Local Code Index v2 release checks passed.`);
    process.exitCode = 0;
    return;
  }

  // Group by file for readable output.
  const byFile = new Map<string, Violation[]>();
  for (const v of allViolations) {
    const list = byFile.get(v.file) || [];
    list.push(v);
    byFile.set(v.file, list);
  }

  console.log(`${FAIL} Found ${allViolations.length} release violation(s) across ${byFile.size} file(s):\n`);

  for (const [file, violations] of byFile) {
    console.log(`  ${file}`);
    for (const v of violations) {
      console.log(`    line ${v.line}: [${v.rule.label}] ${v.matchedText}`);
    }
    console.log("");
  }

  console.log("These violations must be resolved before the v2 release.");
  console.log("Allowed exceptions: migration fixtures, migration recognizer, state gate.\n");

  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`${FAIL} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
