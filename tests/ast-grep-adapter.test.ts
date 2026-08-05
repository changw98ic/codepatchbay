import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { AstGrepAdapter } from "../core/indexing/local-code-index/ast-grep-adapter.js";
import { tempRoot } from "./helpers.js";

// flow-2hh: direct adapter tests for the in-process @ast-grep/napi references
// path. failedLang-scenario and service-stub coverage (which need a loadNapi
// mock / adapter stub) are tracked separately; these cover the feasible
// contract surface: abort, multi-language extraction, deterministic order,
// per-file truncation, and the failedLangPaths/truncatedPaths contract.

async function makeAdapterWithFiles(
  label: string,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<{ adapter: AstGrepAdapter; sourcePath: string }> {
  const sourcePath = await tempRoot(`adapter-${label}`);
  await mkdir(sourcePath, { recursive: true });
  for (const [name, content] of files) {
    await writeFile(path.join(sourcePath, name), content, "utf8");
  }
  const adapter = new AstGrepAdapter({ binaryPath: "ast-grep", cwd: sourcePath });
  return { adapter, sourcePath };
}

test("extractReferences rejects an already-aborted signal with operation_aborted", async () => {
  const { adapter } = await makeAdapterWithFiles("abort", [["a.ts", "const a = 1;\n"]]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    adapter.extractReferences(["a.ts"], { signal: ac.signal }),
    (err: unknown) => err instanceof Error && /operation_aborted/.test(err.message),
  );
});

test("extractReferences extracts references across multiple languages", async () => {
  const { adapter } = await makeAdapterWithFiles("multilang", [
    ["mod.ts", "export function alpha(x: number): number { return alpha(x); }\n"],
    ["a.py", "def beta(y):\n    return beta(y)\n"],
    ["b.go", "package main\nfunc gamma(w int) int { return gamma(w) }\n"],
  ]);
  const result = await adapter.extractReferences(["mod.ts", "a.py", "b.go"]);
  assert.equal(result.files.length, 3);
  const byLang = new Map(result.files.map((f) => [f.language, f.symbols.length]));
  assert.ok((byLang.get("TypeScript") ?? 0) > 0, "TypeScript references");
  assert.ok((byLang.get("python") ?? 0) > 0, "python references");
  assert.ok((byLang.get("go") ?? 0) > 0, "go references");
  // Every emitted symbol is a reference (role set by the napi path).
  for (const file of result.files) {
    for (const symbol of file.symbols) {
      assert.equal(symbol.role, "reference");
    }
  }
});

test("extractReferences returns files in path-sorted order regardless of input order", async () => {
  const { adapter } = await makeAdapterWithFiles("order", [
    ["zeta.ts", "const z = 1;\n"],
    ["alpha.ts", "const a = 1;\n"],
    ["mid.ts", "const m = 1;\n"],
  ]);
  const result = await adapter.extractReferences(["zeta.ts", "alpha.ts", "mid.ts"]);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["alpha.ts", "mid.ts", "zeta.ts"],
  );
});

test("extractReferences caps per-file references and marks truncatedPaths", async () => {
  // 10001 identifier occurrences -> capped at 10000, file marked truncated.
  const big = `${Array.from({ length: 10001 }, () => "a").join(";\n")};\n`;
  const { adapter } = await makeAdapterWithFiles("trunc", [["big.ts", big]]);
  const result = await adapter.extractReferences(["big.ts"]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.symbols.length, 10_000);
  assert.equal(result.truncated, true);
  assert.ok(result.truncatedPaths?.has("big.ts"));
});

test("extractReferences always returns the failedLangPaths and truncatedPaths contract fields", async () => {
  const { adapter } = await makeAdapterWithFiles("contract", [["a.ts", "const a = 1;\n"]]);
  const result = await adapter.extractReferences(["a.ts"]);
  assert.ok(result.failedLangPaths instanceof Set);
  assert.ok(result.truncatedPaths instanceof Set);
  assert.equal(result.failedLangPaths.size, 0);
});
