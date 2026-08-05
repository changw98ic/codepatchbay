import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { ensureLocalCodeIndex } from "../core/indexing/local-code-index/service.js";
import { queryLocalCodeIndex } from "../core/indexing/local-code-index/query.js";
import { tempRoot, listFiles } from "./helpers.js";

// flow-2hh napi 迁移的关键基线门（策略无关）。
//
// 用真实 ast-grep（PATH，非 fake 二进制）端到端跑 ensureLocalCodeIndex：
//   build #1 全新 → build #2 无 force（应复用）→ build #3 force 重建。
//
// 抓四类回归（迁移后同测试必须仍绿）：
//   (1) 指纹漂移：build #2 错误重抽（parsedFiles>0）。
//   (2) references 非确定性：force 重建若 references 顺序变 → 同 fileObjectId 不同 bytes
//       → object_identity_collision。build #3 必须成功。
//   (3) references 被抽空（迁移 bug）：references 查询必须非空。
//   (4) 身份不稳：snapshotId / fingerprint 跨构建必须不变。

test("ensureLocalCodeIndex reuses snapshot on second build and force-rebuild is byte-deterministic", async () => {
  const root = await tempRoot("reuse-determinism");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  // Multiple files across languages, parsed concurrently by the napi adapter's
  // bounded worker pool. The byte-identical force-rebuild check below reads
  // EVERY published file object, so it exercises multi-file concurrency
  // determinism — the single-file shape could not catch completion-order leaks.
  await writeFile(
    path.join(sourcePath, "mod.ts"),
    "export function alpha(x: number): number { return alpha(x); }\nconst b = alpha(1);\n",
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "util.ts"),
    "import { alpha } from './mod';\nexport function beta() { return alpha(0); }\nconst c = beta();\n",
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "a.py"),
    "def delta(y):\n    return delta(y - 1) if y > 0 else 0\nz = delta(3)\n",
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "b.go"),
    "package main\nfunc gamma(w int) int { return gamma(w) }\n",
    "utf8",
  );

  // ── build #1：全新 ──────────────────────────────────────────────────────
  const r1 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(r1.available, true, "build #1 available");
  assert.ok(r1.stats.parsedFiles > 0, "build #1 must parse files");
  const snap1 = r1.ref.snapshotId;
  const fp1 = r1.tool.extractorFingerprint;

  // references 真抽到了（防迁移把 references 抽空还假绿）。
  const refs1 = await queryLocalCodeIndex(
    r1.ref,
    { kind: "references", symbol: "alpha", match: "exact" },
    { cpbRoot },
  );
  if (refs1.kind !== "references") throw new Error("expected references query");
  assert.ok(
    refs1.occurrences.length > 0,
    "references must be non-empty (migration must not silently empty references)",
  );

  // 读 build #1 的 file object canonical 字节（最硬的确定性锚点）。
  const storageRoot = path.join(cpbRoot, "indexes", "local-code", "v2");
  const filesDir = path.join(storageRoot, "repositories", r1.ref.repositoryKey, "objects", "files");
  const readObjectBytes = async (): Promise<string[]> => {
    const files = await listFiles(filesDir);
    return Promise.all(files.sort().map((f) => readFile(f, "utf8")));
  };
  const bytesAfterBuild1 = await readObjectBytes();
  assert.ok(bytesAfterBuild1.length > 0, "file object must be published");

  // ── build #2：无 force，应复用（抓指纹漂移）─────────────────────────────
  const r2 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(r2.available, true);
  assert.equal(r2.stats.parsedFiles, 0, "build #2 must reuse (no re-extraction)");
  assert.equal(r2.ref.snapshotId, snap1, "build #2 same snapshotId");
  assert.equal(r2.tool.extractorFingerprint, fp1, "build #2 same fingerprint (no drift)");

  // ── build #3：force 重建 ───────────────────────────────────────────────
  // force 把每个 file object 重新发布到同一路径（fileObjectId 由
  // language/parserMode/extractorFingerprint/sourceContentId 决定，指纹不变则路径不变）；
  // 若 references 顺序不确定 → canonical bytes 不同 → object_identity_collision。
  const r3 = await ensureLocalCodeIndex({ cpbRoot, sourcePath, force: true });
  assert.equal(r3.available, true, "force rebuild must succeed (byte-determinism, no collision)");
  assert.ok(r3.stats.parsedFiles > 0, "build #3 force must re-parse");
  assert.equal(r3.ref.snapshotId, snap1, "build #3 same snapshotId (identity stable)");
  assert.equal(r3.tool.extractorFingerprint, fp1, "build #3 same fingerprint");

  // force 重建后 file object 字节必须与 build #1 byte-identical（确定性硬证据）。
  const bytesAfterBuild3 = await readObjectBytes();
  assert.deepEqual(
    bytesAfterBuild3,
    bytesAfterBuild1,
    "file object bytes must be byte-identical across force rebuild (references order stable)",
  );

  // references 查询结果跨 force 重建一致（顺序稳定的额外佐证）。
  const refs3 = await queryLocalCodeIndex(
    r3.ref,
    { kind: "references", symbol: "alpha", match: "exact" },
    { cpbRoot },
  );
  if (refs3.kind !== "references") throw new Error("expected references query");
  assert.deepEqual(
    refs3.occurrences.map((o) => ({
      path: o.path,
      startLine: o.range.startLine,
      startColumn: o.range.startColumn,
    })),
    refs1.occurrences.map((o) => ({
      path: o.path,
      startLine: o.range.startLine,
      startColumn: o.range.startColumn,
    })),
    "references query identical after force rebuild",
  );
});
