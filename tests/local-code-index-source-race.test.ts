import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { localCodeIndexStatus, ensureLocalCodeIndex } from "../core/indexing/local-code-index/service.js";
import { tempRoot } from "./helpers.js";

// ── Source race: directory changes between observation A and B ────────────────

test("localCodeIndexStatus reports unavailable when no index exists", async () => {
  const root = await tempRoot("source-race-status");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "export const a = 1;\n", "utf8");

  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, false, "should be unavailable when no index exists");
  assert.ok(status.reason, "reason should be set");
});

test("ensureLocalCodeIndex succeeds for a stable directory", async () => {
  const root = await tempRoot("source-race-ensure");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "stable.ts"), "export const x = 1;\n", "utf8");

  // Run ensure on a stable directory — should succeed.
  const result = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result.available, true, "first ensure should succeed");
  assert.ok(result.ref.snapshotId, "snapshotId should be set");
});

test("localCodeIndexStatus reports available after ensure publishes", async () => {
  const root = await tempRoot("source-race-detect");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  // Publish first snapshot.
  const result = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result.available, true);

  // Status should now report available and exact.
  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true, "should be available after ensure");
  assert.equal(status.exact, true, "should be exact when source hasn't changed");
});

test("localCodeIndexStatus reports stale when source changes after publication", async () => {
  const root = await tempRoot("source-race-stale");
  const sourcePath = path.join(root, "src");
  const cpbRoot = path.join(root, ".cpb");

  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(path.join(sourcePath, "a.ts"), "const a = 1;\n", "utf8");

  // Publish first snapshot.
  const result = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result.available, true);

  // Now mutate the source directory.
  await writeFile(path.join(sourcePath, "b.ts"), "const b = 2;\n", "utf8");

  // Status keeps the stored snapshot available, but must report that it no
  // longer exactly matches the current source.
  const status = await localCodeIndexStatus({ cpbRoot, sourcePath });
  assert.equal(status.available, true, "should still be available");
  assert.equal(status.exact, true, "the two current observations are exact");
  assert.equal(status.fresh, false, "changed source must make the snapshot stale");
  assert.equal(status.reason, "local_code_index_stale");

  // Re-ensure to update the index with the new source state.
  const result2 = await ensureLocalCodeIndex({ cpbRoot, sourcePath });
  assert.equal(result2.available, true);
});
