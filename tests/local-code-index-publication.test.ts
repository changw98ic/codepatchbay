import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { ensureLocalCodeIndex, localCodeIndexStatus } from "../core/indexing/local-code-index/service.js";
import { queryLocalCodeIndex } from "../core/indexing/local-code-index/query.js";
import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";
import {
  snapshotIdentityPath,
  worktreeCurrentPointer,
} from "../core/indexing/local-code-index/paths.js";
import { tempRoot } from "./helpers.js";

// ── Publication: ensure writes index and status reports correctly ────────────

test("ensureLocalCodeIndex succeeds when source is stable", async () => {
  const root = await tempRoot("pub-basic");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "index.ts"), "export {};\n", "utf8");

  const result = await ensureLocalCodeIndex({ cpbRoot, sourcePath });

  assert.equal(result.available, true, "should be available after ensure");
  assert.ok(result.ref, "ref should be set");
  assert.ok(result.ref.snapshotId, "snapshotId should be set");
});

test("ensureLocalCodeIndex uses the configured ast-grep executable for structural definitions", async () => {
  const root = await tempRoot("pub-ast-grep");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");
  const fakeAstGrep = path.join(root, "fake-ast-grep");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(
    path.join(sourcePath, "index.ts"),
    "export function configuredParser(): void {} configuredParser();\n",
    "utf8",
  );
  await writeFile(path.join(sourcePath, "README.md"), "# parser fixture\n", "utf8");
  await writeFile(
    fakeAstGrep,
    [
      "#!/bin/sh",
      "case \" $* \" in",
      "  *\" --version \"*) printf '%s\\n' 'ast-grep 0.0.0-test'; exit 0 ;;",
      "esac",
      "case \" $* \" in",
      "  *\" run \"*)",
      "    printf '%s\\n' '{\"text\":\"configuredParser\",\"file\":\"index.ts\",\"language\":\"TypeScript\",\"range\":{\"start\":{\"line\":0,\"column\":35},\"end\":{\"line\":0,\"column\":51}}}'",
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"path\":\"index.ts\",\"language\":\"TypeScript\",\"items\":[{\"role\":\"item\",\"symbolType\":\"function\",\"name\":\"configuredParser\",\"range\":{\"start\":{\"line\":0,\"column\":0},\"end\":{\"line\":0,\"column\":43}},\"signature\":\"export function configuredParser(): void {}\",\"isExported\":true,\"members\":[]}]}'",
      "    ;;",
      "esac",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeAstGrep, 0o755);

  const result = await ensureLocalCodeIndex({
    cpbRoot,
    sourcePath,
    astGrepBinaryPath: fakeAstGrep,
  });

  assert.equal(result.tool.available, true);
  assert.equal(result.tool.version, "0.0.0-test");
  assert.deepEqual(result.tool.coverage, {
    effective: "file-inventory-only",
    partial: true,
    failedFiles: 0,
    oversizedFiles: 0,
  });

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true);
  assert.deepEqual(status.tool.coverage, result.tool.coverage);

  const query = await queryLocalCodeIndex(result.ref, {
    kind: "definitions",
    symbol: "configuredParser",
    match: "exact",
  }, { cpbRoot });
  assert.equal(query.kind, "definitions");
  assert.equal(query.occurrences.length, 1);
  assert.equal(query.occurrences[0]?.path, "index.ts");
  assert.equal(query.occurrences[0]?.coverage, "ast-grep-structural");

  const references = await queryLocalCodeIndex(result.ref, {
    kind: "references",
    symbol: "configuredParser",
    match: "exact",
  }, { cpbRoot });
  assert.equal(references.kind, "references");
  assert.equal(references.occurrences.length, 1);
  assert.equal(references.occurrences[0]?.path, "index.ts");
  assert.equal(references.occurrences[0]?.range.startColumn, 36);
  assert.equal(references.occurrences[0]?.coverage, "ast-grep-structural");

  const summary = await queryLocalCodeIndex(result.ref, {
    kind: "file-summary",
    path: "index.ts",
  }, { cpbRoot });
  assert.equal(summary.kind, "file-summary");
  assert.equal(summary.file?.language, "typescript");
  assert.equal(summary.file?.coverage, "ast-grep-structural");

  const inventory = await queryLocalCodeIndex(result.ref, {
    kind: "inventory",
  }, { cpbRoot });
  assert.equal(inventory.kind, "inventory");
  assert.deepEqual(
    inventory.files.map((file) => ({
      path: file.path,
      language: file.language,
      coverage: file.coverage,
      nodeCount: file.nodeCount,
    })),
    [
      {
        path: "README.md",
        language: "markdown",
        coverage: "file-inventory-only",
        nodeCount: 1,
      },
      {
        path: "index.ts",
        language: "typescript",
        coverage: "ast-grep-structural",
        nodeCount: 2,
      },
    ],
  );

  const parserSource = await readFile(fakeAstGrep, "utf8");
  await writeFile(
    fakeAstGrep,
    parserSource.replace("ast-grep 0.0.0-test", "ast-grep 0.0.1-test"),
    "utf8",
  );
  const reparsed = await ensureLocalCodeIndex({
    cpbRoot,
    sourcePath,
    astGrepBinaryPath: fakeAstGrep,
  });
  assert.equal(reparsed.tool.version, "0.0.1-test");
  assert.equal(reparsed.stats.parsedFiles, 2);
  assert.notEqual(reparsed.ref.snapshotId, result.ref.snapshotId);
});

test("ensureLocalCodeIndex amortizes outline process startup while retaining bounded reference batches", async () => {
  const root = await tempRoot("pub-parser-batches");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");
  const fakeAstGrep = path.join(root, "fake-ast-grep");
  const invocationLog = path.join(root, "parser-invocations.log");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  for (let index = 0; index < 121; index += 1) {
    await writeFile(path.join(sourcePath, `file-${index}.ts`), `export const value${index} = ${index};\n`, "utf8");
  }
  await writeFile(
    fakeAstGrep,
    [
      "#!/bin/sh",
      "case \" $* \" in",
      "  *\" --version \"*) printf '%s\\n' 'ast-grep 0.0.0-test'; exit 0 ;;",
      "esac",
      `printf '%s\\n' \"$1\" >> '${invocationLog}'`,
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeAstGrep, 0o755);

  await ensureLocalCodeIndex({
    cpbRoot,
    sourcePath,
    astGrepBinaryPath: fakeAstGrep,
  });

  const invocations = (await readFile(invocationLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(invocations.filter((value) => value === "outline").length, 1);
  assert.equal(invocations.filter((value) => value === "run").length, 2);
});

test("ensureLocalCodeIndex is idempotent — running twice produces same snapshot", async () => {
  const root = await tempRoot("pub-idempotent");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  const result1 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  const result2 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });

  assert.equal(result1.available, true);
  assert.equal(result2.available, true);
  assert.equal(result1.ref.snapshotId, result2.ref.snapshotId, "idempotent: same snapshot");
});

test("ensureLocalCodeIndex re-publishes when source changes between runs", async () => {
  const root = await tempRoot("pub-republish");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  const result1 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result1.available, true);

  // Mutate source.
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 999;\n", "utf8");

  const result2 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result2.available, true, "should re-publish after source change");
});

test("localCodeIndexStatus reports exact after ensure publishes", async () => {
  const root = await tempRoot("pub-status-exact");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  await ensureLocalCodeIndex({ cpbRoot, sourcePath });

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true, "should be available after ensure");
  assert.equal(status.exact, true, "should be exact when source hasn't changed");
});

test("localCodeIndexStatus rejects snapshots with the retired scalar coverage shape", async () => {
  const root = await tempRoot("pub-status-old-coverage");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "export const a = 1;\n", "utf8");

  const result = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  const storageRoot = path.join(cpbRoot, "indexes", "local-code", "v2");
  const identityPath = snapshotIdentityPath(
    storageRoot,
    result.ref.worktreeKey,
    result.ref.snapshotId,
  );
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  identity.toolState.coverage = "file-inventory-only";
  const identityBytes = canonicalStringify(identity);
  await writeFile(identityPath, identityBytes, "utf8");

  const pointerPath = worktreeCurrentPointer(storageRoot, result.ref.worktreeKey);
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  pointer.identityHash = createHash("sha256").update(identityBytes).digest("hex");
  await writeFile(pointerPath, canonicalStringify(pointer), "utf8");

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, false);
  assert.equal(status.reason, "unsupported_index_schema");
});

test("localCodeIndexStatus reports available after source changes (stored snapshot is valid)", async () => {
  const root = await tempRoot("pub-status-stale");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  await ensureLocalCodeIndex({ cpbRoot, sourcePath });

  // Mutate source after publication.
  await writeFile(path.join(sourcePath, "new.ts"), "const n = 2;\n", "utf8");

  // Status still reports available and exact (the stored snapshot is valid).
  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true, "should still be available");
  assert.equal(status.exact, true, "exact is always true when index exists");
});

test("localCodeIndexStatus reports unavailable when no index exists", async () => {
  const root = await tempRoot("pub-status-no-pointer");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  // Don't call ensureLocalCodeIndex — no index should exist.
  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, false, "should be unavailable without index");
  assert.ok(status.reason, "reason should be set");
});

test("localCodeIndexStatus reports unavailable when source does not exist", async () => {
  const root = await tempRoot("pub-status-unavail");
  const sourcePath = path.join(root, "nonexistent");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(cpbRoot, { recursive: true });

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, false, "should be unavailable for missing source");
});

test("publication preserves consistency between ensure and status", async () => {
  const root = await tempRoot("pub-payload-preserve");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  const ensureResult = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(ensureResult.available, true);

  const statusResult = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(statusResult.available, true);
  assert.equal(statusResult.exact, true);
  assert.equal(statusResult.ref.snapshotId, ensureResult.ref.snapshotId, "snapshot IDs must match");
});
