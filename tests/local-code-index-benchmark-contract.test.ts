import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import {
  FIXTURE_SEED,
  SCENARIOS,
  benchmarkRelatedPaths,
  benchmarkSymbol,
} from "./benchmarks/local-code-index-v2/scenarios.js";
import {
  computeContentHash,
  computeInventoryHash,
  fixtureRelativePath,
  generateFixture,
} from "./benchmarks/local-code-index-v2/generate.js";
import {
  ensureLocalCodeIndex,
  localCodeIndexStatus,
  readSnapshotIdentity,
  resolveStorageRoot,
} from "../core/indexing/local-code-index/index.js";

const execFileAsync = promisify(execFile);

describe("Local Code Index v2 benchmark contract", () => {
  test("defines exactly ten operations at both canonical fixture sizes", () => {
    assert.equal(SCENARIOS.length, 20);
    assert.deepEqual(
      [...new Set(SCENARIOS.map((scenario) => scenario.fixtureSize))],
      [1000, 10000],
    );
    assert.equal(new Set(SCENARIOS.map((scenario) => scenario.operation)).size, 10);
    assert.equal(FIXTURE_SEED, "0x4350424944585632");
    assert.equal(benchmarkSymbol(1000), "module00500");
    assert.equal(benchmarkSymbol(10000), "module05000");
    assert.deepEqual(benchmarkRelatedPaths(1000), [
      "src/005/module00500.ts",
      "src/005/module00501.ts",
    ]);
  });

  test("path assignment is deterministic with 100 files per directory and 70/20/10 languages", () => {
    assert.equal(fixtureRelativePath(0), "src/000/module00000.ts");
    assert.equal(fixtureRelativePath(6), "src/000/module00006.ts");
    assert.equal(fixtureRelativePath(7), "src/000/module00007.js");
    assert.equal(fixtureRelativePath(9), "src/000/module00009.json");
    assert.equal(fixtureRelativePath(100), "src/001/module00100.ts");
  });

  test("1000-file generator emits exact bytes, reproducible Git branches, and hashes", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lci-v2-generator-"));
    try {
      const manifest = await generateFixture(1000, root);
      assert.equal(manifest.eligibleFiles, 1000);
      assert.equal(manifest.eligibleBytes, 1000 * 4096);
      assert.deepEqual(manifest.languageDistribution, {
        typescript: 700,
        javascript: 200,
        json: 100,
      });
      assert.match(manifest.generatedInventorySha256, /^[0-9a-f]{64}$/u);
      assert.match(manifest.generatedContentSha256, /^[0-9a-f]{64}$/u);
      assert.equal((await stat(path.join(root, fixtureRelativePath(500)))).size, 4096);
      assert.equal((await readFile(path.join(root, fixtureRelativePath(500)), "utf8")).includes("module00500"), true);

      const { stdout: branches } = await execFileAsync("git", ["branch", "--format=%(refname:short)"], { cwd: root });
      assert.deepEqual(branches.trim().split("\n").sort(), ["branch-a", "branch-b", "main"]);
      const { stdout: branchAChanges } = await execFileAsync(
        "git",
        ["diff", "--name-only", "main", "branch-a"],
        { cwd: root },
      );
      const { stdout: branchBChanges } = await execFileAsync(
        "git",
        ["diff", "--name-only", "main", "branch-b"],
        { cwd: root },
      );
      const branchASet = new Set(branchAChanges.trim().split("\n").filter(Boolean));
      const branchBSet = new Set(branchBChanges.trim().split("\n").filter(Boolean));
      assert.equal(branchASet.size, 100);
      assert.equal(branchBSet.size, 100);
      assert.equal([...branchASet].filter((file) => branchBSet.has(file)).length, 50);

      const synthetic = [
        { relativePath: "a", content: "x", language: "typescript" as const },
      ];
      assert.equal(computeInventoryHash(synthetic).length, 64);
      assert.equal(computeContentHash(synthetic), createHash("sha256").update("a\0x\0").digest("hex"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("empty, copied-baseline, and one-file refresh modes are exact", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lci-v2-incremental-"));
    const source = path.join(root, "source");
    const baseline = path.join(root, "baseline");
    const copied = path.join(root, "copied");
    try {
      await mkdir(path.join(source, "src"), { recursive: true });
      await writeFile(path.join(source, "src", "a.ts"), "export function alpha() { return 1; }\n");
      await writeFile(path.join(source, "src", "b.ts"), "export function beta() { return alpha(); }\n");
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: source });
      await execFileAsync("git", ["add", "--all"], { cwd: source });
      await execFileAsync(
        "git",
        ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.test", "commit", "-q", "-m", "base"],
        { cwd: source },
      );
      await mkdir(baseline);
      const first = await ensureLocalCodeIndex({ sourcePath: source, cpbRoot: baseline });
      assert.equal(first.stats.mode, "full");
      assert.equal(first.stats.parsedFiles, 2);

      await cp(baseline, copied, { recursive: true });
      const status = await localCodeIndexStatus({ sourcePath: source, cpbRoot: copied });
      assert.equal(status.available, true);
      assert.equal(status.fresh, true);
      assert.equal(status.exact, true);
      const reused = await ensureLocalCodeIndex({ sourcePath: source, cpbRoot: copied });
      assert.equal(reused.stats.mode, "reused");
      assert.equal(reused.stats.parsedFiles, 0);
      assert.equal(reused.ref.snapshotId, first.ref.snapshotId);

      const storageRoot = await resolveStorageRoot(copied, source);
      const identity = await readSnapshotIdentity(
        storageRoot,
        reused.ref.worktreeKey,
        reused.ref.snapshotId,
      );
      assert.equal(identity?.sourcePath, first.ref.sourcePath);
      assert.equal(identity?.sourceKey, reused.ref.sourceKey);

      await writeFile(path.join(source, "src", "a.ts"), "export function alpha() { return 2; }\n");
      const refreshed = await ensureLocalCodeIndex({ sourcePath: source, cpbRoot: copied });
      assert.equal(refreshed.stats.mode, "incremental");
      assert.equal(refreshed.stats.parsedFiles, 1);
      assert.equal(refreshed.stats.rebuiltSymbolShards, 0);
      assert.equal(refreshed.stats.rebuiltRelationShards, 1);
      assert.notEqual(refreshed.ref.snapshotId, reused.ref.snapshotId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
