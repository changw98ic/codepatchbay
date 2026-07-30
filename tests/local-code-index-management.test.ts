import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensureLocalCodeIndex,
  localCodeIndexStatus,
} from "../core/indexing/local-code-index/service.js";
import { queryLocalCodeIndex } from "../core/indexing/local-code-index/query.js";
import {
  resolveStorageAuthority,
  resolveStorageRoot,
} from "../core/indexing/local-code-index/paths.js";
import { garbageCollect } from "../core/indexing/local-code-index/gc.js";

test("resolveStorageAuthority creates a private authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-mgmt-authority-"));
  try {
    const result = await resolveStorageAuthority({ cpbRoot: root });
    assert.equal(result.ok, true);
    if (result.ok) {
      const info = await stat(result.authority);
      assert.equal(info.mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical ensure, status, query, and GC share one snapshot contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-mgmt-canonical-"));
  const sourcePath = path.join(root, "source");
  const cpbRoot = path.join(root, "runtime");
  try {
    await mkdir(sourcePath, { recursive: true });
    await mkdir(cpbRoot, { recursive: true });
    await writeFile(
      path.join(sourcePath, "main.ts"),
      "export function managedSymbol(): string { return 'ok'; }\n",
    );

    const ensured = await ensureLocalCodeIndex({ sourcePath, cpbRoot });
    const status = await localCodeIndexStatus({ sourcePath, cpbRoot });
    assert.equal(status.available, true);
    assert.equal(status.fresh, true);
    assert.equal(status.exact, true);
    if (!status.available) assert.fail(status.reason);
    assert.equal(status.ref.snapshotId, ensured.ref.snapshotId);

    const query = await queryLocalCodeIndex(
      status.ref,
      { kind: "definitions", symbol: "managedSymbol", match: "exact" },
      { cpbRoot },
    );
    assert.equal(query.kind, "definitions");
    if (query.kind !== "definitions") assert.fail("wrong query result");
    assert.ok(query.occurrences.some((item) => item.symbol === "managedSymbol"));

    const storageRoot = await resolveStorageRoot(cpbRoot, sourcePath);
    const gc = await garbageCollect({
      storageRoot,
      repositoryKey: status.ref.repositoryKey,
    });
    assert.ok(gc.retainedSnapshots >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical status reports stale without replacing the published ref", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-mgmt-stale-"));
  const sourcePath = path.join(root, "source");
  const cpbRoot = path.join(root, "runtime");
  try {
    await mkdir(sourcePath, { recursive: true });
    await mkdir(cpbRoot, { recursive: true });
    await writeFile(path.join(sourcePath, "a.ts"), "export const a = 1;\n");
    const ensured = await ensureLocalCodeIndex({ sourcePath, cpbRoot });
    await writeFile(path.join(sourcePath, "b.ts"), "export const b = 2;\n");

    const status = await localCodeIndexStatus({ sourcePath, cpbRoot });
    assert.equal(status.available, true);
    assert.equal(status.fresh, false);
    assert.equal(status.reason, "local_code_index_stale");
    if (!status.available) assert.fail(status.reason);
    assert.equal(status.ref.snapshotId, ensured.ref.snapshotId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
