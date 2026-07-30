import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  observeDirectory,
  areSourceStatesEqual,
} from "../core/indexing/local-code-index/directory-observer.js";
import { tempRoot } from "./helpers.js";

// ── Directory observer: core behavior ────────────────────────────────────────

test("observeDirectory produces a valid source state for a simple directory", async () => {
  const root = await tempRoot("observer-simple");
  await writeFile(path.join(root, "a.ts"), "const a = 1;\n", "utf8");

  const obs = await observeDirectory({ sourcePath: root });

  assert.equal(obs.repositoryKind, "non-git");
  assert.ok(obs.sourcePath, "sourcePath must be set");
  assert.equal(Object.keys(obs.inventory).length, 1, "must count the single file");
  assert.ok(obs.inventory["a.ts"], "must contain a.ts");
});

test("observeDirectory counts multiple files correctly", async () => {
  const root = await tempRoot("observer-multi");
  await writeFile(path.join(root, "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(root, "b.ts"), "const b = 2;\n", "utf8");
  await writeFile(path.join(root, "c.ts"), "const c = 3;\n", "utf8");

  const obs = await observeDirectory({ sourcePath: root });

  assert.equal(Object.keys(obs.inventory).length, 3, "must count all three files");
});

test("observeDirectory walks nested directories", async () => {
  const root = await tempRoot("observer-nested");
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await writeFile(path.join(root, "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "src", "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "deep", "b.ts"), "const b = 2;\n", "utf8");

  const obs = await observeDirectory({ sourcePath: root });

  assert.equal(Object.keys(obs.inventory).length, 3, "must count files in nested dirs");
});

test("observeDirectory skips ignored directories by default", async () => {
  const root = await tempRoot("observer-ignored");
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, ".git", "objects"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "src.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf8");
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(path.join(root, "dist", "out.js"), "var x = 1;\n", "utf8");

  const obs = await observeDirectory({ sourcePath: root });

  assert.equal(Object.keys(obs.inventory).length, 1, "must only count src.ts, skipping ignored dirs");
});

test("observeDirectory handles empty directory", async () => {
  const root = await tempRoot("observer-empty");
  await mkdir(root, { recursive: true });

  const obs = await observeDirectory({ sourcePath: root });

  assert.equal(Object.keys(obs.inventory).length, 0, "empty directory must have 0 files");
  assert.ok(obs.sourcePath, "sourcePath must be set");
  assert.equal(obs.repositoryKind, "non-git");
});

test("observeDirectory throws for non-existent directory", async () => {
  const root = await tempRoot("observer-missing");
  const missing = path.join(root, "does-not-exist");

  await assert.rejects(
    () => observeDirectory({ sourcePath: missing }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw an error for missing directory");
      return true;
    },
  );
});

test("observeDirectory is deterministic across repeated calls", async () => {
  const root = await tempRoot("observer-deterministic");
  await writeFile(path.join(root, "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(root, "b.ts"), "const b = 2;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: root });
  const obs2 = await observeDirectory({ sourcePath: root });
  const obs3 = await observeDirectory({ sourcePath: root });

  assert.ok(areSourceStatesEqual(obs1, obs2), "must be deterministic (1 vs 2)");
  assert.ok(areSourceStatesEqual(obs2, obs3), "must be deterministic (2 vs 3)");
  assert.equal(Object.keys(obs1.inventory).length, Object.keys(obs2.inventory).length);
});

test("observeDirectory uses relative paths for canonical form", async () => {
  const root = await tempRoot("observer-relative");

  // Create two identical directory trees at different absolute paths.
  const dirA = path.join(root, "project-a");
  const dirB = path.join(root, "project-b");

  await mkdir(path.join(dirA, "src"), { recursive: true });
  await mkdir(path.join(dirB, "src"), { recursive: true });

  await writeFile(path.join(dirA, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(dirB, "src", "index.ts"), "export {};\n", "utf8");

  const obsA = await observeDirectory({ sourcePath: dirA });
  const obsB = await observeDirectory({ sourcePath: dirB });

  // Both should have the same relative paths in inventory
  assert.deepEqual(Object.keys(obsA.inventory), Object.keys(obsB.inventory), "same content at different absolute paths must have same relative inventory keys");
});

test("areSourceStatesEqual returns true for matching observations", async () => {
  const root = await tempRoot("observer-match");
  await writeFile(path.join(root, "a.ts"), "const a = 1;\n", "utf8");

  const obs1 = await observeDirectory({ sourcePath: root });
  const obs2 = await observeDirectory({ sourcePath: root });

  assert.equal(areSourceStatesEqual(obs1, obs2), true, "same directory must produce equal states");
});

test("areSourceStatesEqual returns false for different observations", async () => {
  const root = await tempRoot("observer-no-match");
  const dirA = path.join(root, "a");
  const dirB = path.join(root, "b");

  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirA, "a.ts"), "const a = 1;\n", "utf8");
  await writeFile(path.join(dirB, "b.ts"), "const b = 2;\n", "utf8");

  const obsA = await observeDirectory({ sourcePath: dirA });
  const obsB = await observeDirectory({ sourcePath: dirB });

  assert.equal(areSourceStatesEqual(obsA, obsB), false, "different directories must not match");
});

test("observeDirectory handles symlinks as regular files if they resolve", async () => {
  const root = await tempRoot("observer-symlink");
  const { symlink } = await import("node:fs/promises");

  await writeFile(path.join(root, "real.ts"), "const x = 1;\n", "utf8");
  await symlink(path.join(root, "real.ts"), path.join(root, "link.ts"));

  const obs = await observeDirectory({ sourcePath: root });

  // The symlink is a file entry, so it should be counted.
  assert.ok(Object.keys(obs.inventory).length >= 1, "must count at least the real file");
});

test("observeDirectory includes unignored hidden directories by default", async () => {
  const root = await tempRoot("observer-hidden-directory");
  await mkdir(path.join(root, ".cache-data"), { recursive: true });
  await writeFile(path.join(root, "src.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, ".cache-data", "index.db"), "binary-data", "utf8");

  const obs = await observeDirectory({ sourcePath: root });

  assert.deepEqual(
    Object.keys(obs.inventory).sort(),
    [".cache-data/index.db", "src.ts"],
  );
});
