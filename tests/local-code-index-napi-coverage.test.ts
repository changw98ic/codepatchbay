import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { ensureLocalCodeIndex, _setTestAdapterFactory } from "../core/indexing/local-code-index/service.js";
import { queryLocalCodeIndex } from "../core/indexing/local-code-index/query.js";
import {
  AstGrepAdapter,
} from "../core/indexing/local-code-index/ast-grep-adapter.js";
import type {
  AstGrepExtractionResult,
  AstGrepSymbol,
} from "../core/indexing/local-code-index/ast-grep-adapter.js";
import { tempRoot, listFiles } from "./helpers.js";

// flow-2hh: service-level coverage tests for the napi references path.
// (1) references truncation surfaces end-to-end as FileObject.truncated.
// (2) a failed references language yields lexical-reference-fallback coverage
//     while keeping the structural outline definitions (via an adapter stub).

async function readObjectBytes(filesDir: string): Promise<string[]> {
  const files = await listFiles(filesDir);
  return Promise.all(files.sort().map((f) => readFile(f, "utf8")));
}

test("references truncation surfaces as FileObject.truncated end-to-end", async () => {
  const root = await tempRoot("cov-trunc");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  // 10001 identifier occurrences -> capped at 10000, marked truncated.
  await writeFile(
    path.join(sourcePath, "big.ts"),
    `${Array.from({ length: 10001 }, () => "a").join(";\n")};\n`,
    "utf8",
  );

  const result = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result.available, true);

  const storageRoot = path.join(cpbRoot, "indexes", "local-code", "v2");
  const filesDir = path.join(storageRoot, "repositories", result.ref.repositoryKey, "objects", "files");
  const objects = await readObjectBytes(filesDir);
  assert.ok(objects.length > 0, "file object published");
  const big = JSON.parse(objects.find((o) => o.includes('"references"')) ?? objects[0]!);
  assert.equal(big.truncated, true, "FileObject.truncated must reflect the references cap");
});

// An adapter stub that reports a structural outline definition but says every
// file's references language was unavailable. Subclasses AstGrepAdapter so it
// satisfies the EnsureLocalCodeIndexOptions.adapter seam.
class FailedLangAdapter extends AstGrepAdapter {
  constructor() {
    super({ binaryPath: "ast-grep" });
  }
  override async getVersion(): Promise<string | null> {
    return "test-version";
  }
  override async extractFiles(
    paths: readonly string[],
  ): Promise<AstGrepExtractionResult> {
    const def: AstGrepSymbol = {
      name: "alpha",
      kind: "function",
      role: "definition",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 22 },
      exported: true,
      signature: null,
      astKind: null,
      isImport: false,
      members: [],
    };
    return {
      files: paths.map((p) => ({ path: p, language: "typescript", symbols: [def] })),
      version: "test-version",
      truncated: false,
      errors: [],
    };
  }
  override async extractReferences(
    paths: readonly string[],
  ): Promise<AstGrepExtractionResult> {
    return {
      files: [],
      version: "test-version",
      truncated: false,
      failedLangPaths: new Set(paths),
      errors: [],
    };
  }
}

test("failed references language downgrades coverage but keeps outline definitions", async () => {
  const root = await tempRoot("cov-failedlang");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "mod.ts"), "export function alpha() {}\n", "utf8");

  _setTestAdapterFactory(() => new FailedLangAdapter());
  try {
    const result = await ensureLocalCodeIndex({
      cpbRoot,
      sourcePath,
    });
    assert.equal(result.available, true);
    // The failed-language file counts toward the aggregate failedFiles/partial so
    // the snapshot reports the failure honestly.
    assert.equal(result.tool.coverage.failedFiles, 1);
    assert.equal(result.tool.coverage.partial, true);

    const summary = await queryLocalCodeIndex(
      result.ref,
      { kind: "file-summary", path: "mod.ts" },
      { cpbRoot },
    );
    if (summary.kind !== "file-summary") throw new Error("expected file-summary");
    // Coverage downgraded (references language unavailable) ...
    assert.equal(summary.file?.coverage, "lexical-reference-fallback");
    // ... but the outline definition is retained.
    assert.ok(
      summary.file?.definitions.some((d) => d.symbol === "alpha"),
      "outline definition must be retained on failed-language downgrade",
    );
  } finally {
    _setTestAdapterFactory(null);
  }
});
