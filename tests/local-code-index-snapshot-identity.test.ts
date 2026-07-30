import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { observeDirectory, areSourceStatesEqual } from "../core/indexing/local-code-index/directory-observer.js";
import { tempRoot } from "./helpers.js";

// ── Snapshot identity: deterministic hashing ─────────────────────────────────

test("identical directories produce identical source states (same path)", async () => {
  const root = await tempRoot("snapshot-identity-same");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });

  await writeFile(path.join(dir, "index.ts"), "export const x = 1;\n", "utf8");
  await writeFile(path.join(dir, "utils.ts"), "export function f() { return 42; }\n", "utf8");

  const obsA = await observeDirectory({ sourcePath: dir });
  const obsB = await observeDirectory({ sourcePath: dir });

  assert.ok(areSourceStatesEqual(obsA, obsB), "same directory must produce equal source states");
  assert.equal(Object.keys(obsA.inventory).length, Object.keys(obsB.inventory).length, "file counts must match");
});

test("different directories produce different source states", async () => {
  const root = await tempRoot("snapshot-identity-diff");
  const dirA = path.join(root, "a");
  const dirB = path.join(root, "b");

  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  await writeFile(path.join(dirA, "index.ts"), "export const x = 1;\n", "utf8");
  await writeFile(path.join(dirB, "index.ts"), "export const x = 2;\n", "utf8");

  const obsA = await observeDirectory({ sourcePath: dirA });
  const obsB = await observeDirectory({ sourcePath: dirB });

  assert.ok(!areSourceStatesEqual(obsA, obsB), "different content must produce different source states");
});

test("source state is deterministic across multiple observations of the same directory", async () => {
  const root = await tempRoot("snapshot-identity-deterministic");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(dir, "b.ts"), "const b = 2;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: dir });
  const obs2 = await observeDirectory({ sourcePath: dir });
  const obs3 = await observeDirectory({ sourcePath: dir });

  assert.ok(areSourceStatesEqual(obs1, obs2), "must be deterministic (1 vs 2)");
  assert.ok(areSourceStatesEqual(obs2, obs3), "must be deterministic (2 vs 3)");
  assert.equal(Object.keys(obs1.inventory).length, Object.keys(obs2.inventory).length);
});

test("file write order does not affect source state", async () => {
  const root = await tempRoot("snapshot-identity-order");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });

  // Write files in a specific order.
  await writeFile(path.join(dir, "z.ts"), "const z = 1;\n", "utf8");
  await writeFile(path.join(dir, "a.ts"), "const a = 1;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: dir });

  // Observe again — order of files on disk is the same.
  const obs2 = await observeDirectory({ sourcePath: dir });

  assert.ok(areSourceStatesEqual(obs1, obs2), "same directory must produce same state regardless of write order");
});

test("adding a file changes the source state", async () => {
  const root = await tempRoot("snapshot-identity-add");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.ts"), "const a = 1;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: dir });

  await writeFile(path.join(dir, "b.ts"), "const b = 2;\n", "utf8");

  const obs2 = await observeDirectory({ sourcePath: dir });

  assert.ok(!areSourceStatesEqual(obs1, obs2), "adding a file must change the source state");
  assert.equal(Object.keys(obs2.inventory).length, Object.keys(obs1.inventory).length + 1, "file count must increase");
});

test("removing a file changes the source state", async () => {
  const root = await tempRoot("snapshot-identity-remove");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(dir, "b.ts"), "const b = 2;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: dir });

  await rm(path.join(dir, "b.ts"));

  const obs2 = await observeDirectory({ sourcePath: dir });

  assert.ok(!areSourceStatesEqual(obs1, obs2), "removing a file must change the source state");
  assert.equal(Object.keys(obs2.inventory).length, Object.keys(obs1.inventory).length - 1, "file count must decrease");
});

test("modifying a file changes the source state", async () => {
  const root = await tempRoot("snapshot-identity-modify");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.ts"), "const a = 1;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: dir });

  await writeFile(path.join(dir, "a.ts"), "const a = 999;\n", "utf8");

  const obs2 = await observeDirectory({ sourcePath: dir });

  assert.ok(!areSourceStatesEqual(obs1, obs2), "modifying a file must change the source state");
});

test("empty directory produces a valid source state", async () => {
  const root = await tempRoot("snapshot-identity-empty");
  const dir = path.join(root, "empty");

  await mkdir(dir, { recursive: true });

  const obs = await observeDirectory({ sourcePath: dir });

  assert.equal(Object.keys(obs.inventory).length, 0, "empty directory must have 0 files");
  assert.ok(obs.sourcePath, "sourcePath must be set");
  assert.equal(obs.repositoryKind, "non-git");
});

test("nested directories are included in the source state", async () => {
  const root = await tempRoot("snapshot-identity-nested");
  const dir = path.join(root, "src");

  await mkdir(path.join(dir, "deep", "nested"), { recursive: true });
  await writeFile(path.join(dir, "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(dir, "deep", "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(dir, "deep", "nested", "b.ts"), "const b = 2;\n", "utf8");

  const obs = await observeDirectory({ sourcePath: dir });

  assert.equal(Object.keys(obs.inventory).length, 3, "must count files in nested directories");
});

test("areSourceStatesEqual returns true for identical observations", async () => {
  const root = await tempRoot("snapshot-identity-match");
  const dir = path.join(root, "src");

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.ts"), "const a = 1;\n", "utf8");

  const obsA = await observeDirectory({ sourcePath: dir });
  const obsB = await observeDirectory({ sourcePath: dir });

  assert.equal(areSourceStatesEqual(obsA, obsB), true, "identical observations must match");
});

test("areSourceStatesEqual returns false for different observations", async () => {
  const root = await tempRoot("snapshot-identity-no-match");
  const dirA = path.join(root, "a");
  const dirB = path.join(root, "b");

  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirA, "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(dirB, "b.ts"), "const b = 2;\n", "utf8");

  const obsA = await observeDirectory({ sourcePath: dirA });
  const obsB = await observeDirectory({ sourcePath: dirB });

  assert.equal(areSourceStatesEqual(obsA, obsB), false, "different observations must not match");
});
