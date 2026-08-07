import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { AstGrepAdapter } from "../core/indexing/local-code-index/ast-grep-adapter.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

// flow-2hh: direct adapter tests for the in-process @ast-grep/napi references
// path. failedLang-scenario and service-stub coverage (which need a loadNapi
// mock / adapter stub) are tracked separately; these cover the feasible
// contract surface: abort, multi-language extraction, deterministic order,
// per-file truncation, and the failedLangPaths/truncatedPaths contract.

async function makeAdapterWithFiles(
  label: string,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<AstGrepAdapter> {
  const sourcePath = await tempRoot(`adapter-${label}`);
  await mkdir(sourcePath, { recursive: true });
  for (const [name, content] of files) {
    await writeFile(path.join(sourcePath, name), content, "utf8");
  }
  return new AstGrepAdapter({ binaryPath: "ast-grep", cwd: sourcePath });
}

test("extractReferences rejects an already-aborted signal with operation_aborted", async () => {
  const adapter = await makeAdapterWithFiles("abort", [["a.ts", "const a = 1;\n"]]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    adapter.extractReferences(["a.ts"], { signal: ac.signal }),
    (err: unknown) => err instanceof Error && /operation_aborted/.test(err.message),
  );
});

test("extractReferences extracts references across multiple languages", async () => {
  const adapter = await makeAdapterWithFiles("multilang", [
    ["mod.ts", "export function alpha(x: number): number { return alpha(x); }\n"],
    ["a.py", "def beta(y):\n    return beta(y)\n"],
    ["b.go", "package main\nfunc gamma(w int) int { return gamma(w) }\n"],
    ["c.rs", "fn delta(z: i32) -> i32 { delta(z) }\n"],
  ]);
  const result = await adapter.extractReferences(["mod.ts", "a.py", "b.go", "c.rs"]);
  assert.equal(result.files.length, 4);
  const byLang = new Map(result.files.map((f) => [f.language, f.symbols.length]));
  assert.ok((byLang.get("TypeScript") ?? 0) > 0, "TypeScript references");
  assert.ok((byLang.get("python") ?? 0) > 0, "python references");
  assert.ok((byLang.get("go") ?? 0) > 0, "go references");
  assert.ok((byLang.get("rust") ?? 0) > 0, "rust references");
  // Every emitted symbol is a reference (role set by the napi path).
  for (const file of result.files) {
    for (const symbol of file.symbols) {
      assert.equal(symbol.role, "reference");
    }
  }
});

test("extractReferences returns files in path-sorted order regardless of input order", async () => {
  const adapter = await makeAdapterWithFiles("order", [
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
  // 100001 identifier occurrences -> capped at the 100000-reference bound.
  const big = `${Array.from({ length: 100001 }, () => "a").join(";\n")};\n`;
  const adapter = await makeAdapterWithFiles("trunc", [["big.ts", big]]);
  const result = await adapter.extractReferences(["big.ts"]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.symbols.length, 100_000);
  assert.equal(result.truncated, true);
  assert.ok(result.truncatedPaths?.has("big.ts"));
});

test("extractReferences always returns the failedLangPaths and truncatedPaths contract fields", async () => {
  const adapter = await makeAdapterWithFiles("contract", [["a.ts", "const a = 1;\n"]]);
  const result = await adapter.extractReferences(["a.ts"]);
  assert.ok(result.failedLangPaths instanceof Set);
  assert.ok(result.truncatedPaths instanceof Set);
  assert.equal(result.failedLangPaths.size, 0);
});

test("extractReferences handles malformed/binary source gracefully (tree-sitter recovery)", async () => {
  // napi parseAsync does NOT throw on pathological input (tree-sitter error
  // recovery handles empty/binary/null-byte/malformed). This confirms the
  // adapter degrades gracefully rather than crashing or spuriously marking
  // failedLangPaths. (A true parseAsync throw is not reliably triggerable, so
  // the parse-failure catch is covered by the identical read-failure catch path.)
  const adapter = await makeAdapterWithFiles("malformed", [
    ["bad.py", `${Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0xde]).toString("latin1")}\n`],
    ["broken.ts", "function (((( )))) :::: undefined\n"],
  ]);
  const result = await adapter.extractReferences(["bad.py", "broken.ts"]);
  assert.equal(result.files.length, 2);
  assert.equal(result.failedLangPaths.size, 0, "recovery must not spuriously mark failedLang");
});

test("extractReferences records a failedLangPath for an unreadable file", async () => {
  const adapter = await makeAdapterWithFiles("readfail", [["real.ts", "const a = 1;\n"]]);
  // "ghost.ts" does not exist on disk -> read fails -> failedLangPaths.
  const result = await adapter.extractReferences(["real.ts", "ghost.ts"]);
  assert.ok(result.failedLangPaths.has("ghost.ts"), "unreadable file marked failedLang");
  assert.ok(result.files.some((f) => f.path === "real.ts"), "readable file still extracted");
  assert.ok(result.errors.some((e) => e.includes("ghost.ts")), "failure reason recorded");
});

test("extractReferences is deterministic across two runs", async () => {
  const adapter = await makeAdapterWithFiles("det", [
    ["m.ts", "export function f(x: number) { return f(x); }\n"],
    ["a.py", "def g():\n    return g()\n"],
  ]);
  const r1 = await adapter.extractReferences(["m.ts", "a.py"]);
  const r2 = await adapter.extractReferences(["m.ts", "a.py"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(r1.files)),
    JSON.parse(JSON.stringify(r2.files)),
  );
});

// ── Gate A: ordered CLI↔NAPI identifier equivalence across 7 languages ───────
// The core migration invariant: for each structural language, the in-process
// @ast-grep/napi extraction must produce the SAME identifiers in the SAME order
// as the external `ast-grep run --kind identifier` CLI. Skipped when the CLI is
// not on PATH (e.g., CI without ast-grep installed).

const GATE_A_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ["a.ts", "const alpha = 1;\nfunction beta() { return beta(); }\n"],
  ["b.tsx", "const x = 1;\nfunction Foo() { return <Foo />; }\n"],
  ["c.js", "const a = 1;\nfunction b() { return b(); }\n"],
  ["d.jsx", "const c = 1;\nfunction Bar() { return <Bar />; }\n"],
  ["e.py", "def delta():\n    delta()\n"],
  ["f.go", "package main\nfunc gamma() { gamma() }\n"],
  ["g.rs", "fn epsilon() { epsilon() }\n"],
];

async function cliIdentifiers(absFile: string): Promise<ReadonlyArray<readonly [string, number, number]>> {
  const { stdout } = await execFileAsync(
    "ast-grep",
    ["run", "--kind", "identifier", "--json=stream", absFile],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const out: Array<readonly [string, number, number]> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const j = JSON.parse(trimmed) as { text?: unknown; range?: { start?: { line?: unknown; column?: unknown } } };
      if (
        typeof j.text === "string"
        && Number.isInteger(j.range?.start?.line)
        && Number.isInteger(j.range?.start?.column)
      ) {
        out.push([j.text, j.range!.start!.line as number, j.range!.start!.column as number]);
      }
    } catch { /* skip non-JSON lines */ }
  }
  return out;
}

test("Gate A: napi references match CLI identifier order across all structural languages", async () => {
  let cliAvailable = true;
  try {
    await execFileAsync("ast-grep", ["--version"]);
  } catch {
    cliAvailable = false;
  }
  if (!cliAvailable) {
    console.log("[Gate A] skipped: ast-grep CLI not on PATH");
    return;
  }

  const dir = await tempRoot("gate-a");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of GATE_A_FIXTURES) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  const adapter = new AstGrepAdapter({ binaryPath: "ast-grep", cwd: dir });
  const result = await adapter.extractReferences(GATE_A_FIXTURES.map(([name]) => name));

  for (const [name] of GATE_A_FIXTURES) {
    const cli = await cliIdentifiers(path.join(dir, name));
    const napi = (result.files.find((f) => f.path === name)?.symbols ?? [])
      .map((s) => [s.name, s.range.startLine - 1, s.range.startColumn - 1] as const);
    assert.deepEqual(
      napi,
      cli,
      `Gate A ordered equivalence failed for ${name}: napi !== CLI`,
    );
  }
});
