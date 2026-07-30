import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";
import {
  SCENARIOS,
  benchmarkRelatedPaths,
  benchmarkSymbol,
} from "./benchmarks/local-code-index-v2/scenarios.js";
import { fixtureRelativePath } from "./benchmarks/local-code-index-v2/generate.js";
import { verifyArtifact } from "../scripts/verify-local-code-index-v2-benchmark.js";

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${canonicalStringify(value).trimEnd()}`).digest("hex");
}

function stats(operation: string, size: number): Record<string, unknown> | null {
  if (operation === "full-build") return { mode: "full", discoveredFiles: size, reusedFiles: 0, parsedFiles: size * 0.9 };
  if (operation === "one-file-edit") return { mode: "incremental", parsedFiles: 1 };
  if (operation === "unchanged-ensure") return { mode: "reused", parsedFiles: 0 };
  return null;
}

function validArtifact(): any {
  const commits = { base: "a".repeat(40), branchA: "b".repeat(40), branchB: "c".repeat(40) };
  const fixtures = [1000, 10000].map((size) => ({
    size,
    eligibleFiles: size,
    eligibleBytes: size * 4096,
    seed: "0x4350424944585632",
    generatedInventorySha256: (size === 1000 ? "1" : "2").repeat(64),
    generatedContentSha256: (size === 1000 ? "3" : "4").repeat(64),
    gitObjectFormat: "sha1",
    commits,
    gitIdentity: {
      name: "CPB Benchmark",
      email: "benchmark@codepatchbay.local",
      date: "2025-01-15T10:30:00+00:00",
    },
    languageDistribution: {
      typescript: size * 0.7,
      javascript: size * 0.2,
      json: size * 0.1,
    },
  }));
  const scenarios = SCENARIOS.map((definition) => {
    const request = definition.query?.kind === "related-files"
      ? { ...definition.query, paths: [...definition.query.paths].sort() }
      : definition.query;
    const snapshotId = `idx2-${definition.fixtureSize.toString().padStart(24, "0")}`;
    let semantic: any = null;
    if (definition.query?.kind === "definitions") {
      semantic = {
        kind: "definitions",
        snapshotId,
        occurrences: [{
          path: fixtureRelativePath(definition.fixtureSize / 2),
          symbol: benchmarkSymbol(definition.fixtureSize),
          role: "definition",
        }],
      };
    } else if (definition.query?.kind === "references") {
      const paths = Array.from(
        { length: 8 },
        (_, offset) => fixtureRelativePath(definition.fixtureSize / 2 + offset + 1),
      );
      semantic = {
        kind: "references",
        snapshotId,
        occurrences: [
          ...Array.from({ length: 3 }, () => paths[0]),
          ...Array.from({ length: 3 }, () => paths[1]),
          ...paths.slice(2),
        ].map((entryPath) => ({
          path: entryPath,
          symbol: benchmarkSymbol(definition.fixtureSize),
          role: "reference",
        })),
      };
    } else if (definition.query?.kind === "related-files") {
      const seed = new Set(benchmarkRelatedPaths(definition.fixtureSize));
      const relatedPath = Array.from(
        { length: definition.fixtureSize },
        (_, index) => fixtureRelativePath(index),
      ).find((entryPath) => !seed.has(entryPath))!;
      semantic = {
        kind: "related-files",
        snapshotId,
        files: [{ path: relatedPath, evidence: [{ type: "imports" }] }],
      };
    }
    const outcome = definition.query
      ? {
          kind: "query",
          resultKind: definition.query.kind,
          snapshotId,
          resultCount: semantic.occurrences?.length ?? semantic.files.length,
        }
      : definition.operation === "exact-status" || definition.operation === "non-git-status"
        ? { kind: "status", available: true, fresh: true, exact: true }
        : { kind: "ensure", available: true, snapshotId };
    const sample = {
      durationMs: 1,
      peakRssBytes: 10_000_000,
      stats: stats(definition.operation, definition.fixtureSize),
      outcome,
      requestSha256: definition.query
        ? hash("cpb-local-index-benchmark-request-v1", request)
        : null,
      resultSha256: definition.query
        ? hash("cpb-local-index-benchmark-result-v1", semantic)
        : null,
      semanticResult: semantic,
    };
    return {
      name: definition.id,
      repositoryKind: definition.repositoryKind,
      fixtureSize: definition.fixtureSize,
      operation: definition.operation,
      warmupRuns: 5,
      childRuns: 35,
      samplesMs: Array(30).fill(1),
      p95Ms: 1,
      peakRssBytes: 10_000_000,
      stats: sample.stats,
      samples: Array.from({ length: 30 }, () => structuredClone(sample)),
    };
  });
  return {
    schemaVersion: 1,
    harnessCommit: "d".repeat(40),
    generatorSha256: createHash("sha256").update(readFileSync(
      path.resolve("tests/benchmarks/local-code-index-v2/generate.ts"),
    )).digest("hex"),
    seed: "0x4350424944585632",
    generatedInventorySha256: "2".repeat(64),
    eligibleFiles: 10000,
    eligibleBytes: 10000 * 4096,
    gitObjectFormat: "sha1",
    commits,
    fixtures,
    environment: {
      os: "darwin 25.0.0",
      architecture: "arm64",
      cpuModel: "Test CPU",
      logicalCpuCount: 10,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      storageType: "local-ssd",
      sameFilesystem: true,
      filesystem: "apfs",
      freeMemoryBytes: 4 * 1024 * 1024 * 1024,
      preflightCpuPercent: 5,
      nodeVersion: "v22.22.3",
      gitVersion: "git version 2.50.1",
      astGrepVersion: "ast-grep 0.45.0",
      workRoot: "/tmp/cpb-benchmark",
    },
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T01:00:00.000Z",
    warmupRuns: 5,
    measuredRuns: 30,
    smoke: false,
    scenarios,
    failures: [],
    passed: true,
  };
}

describe("independent benchmark artifact verifier", () => {
  test("accepts complete canonical evidence", () => {
    assert.deepEqual(verifyArtifact(validArtifact()), []);
  });

  test("rejects unsupported Node, interpolated p95, and forged query hashes", () => {
    const artifact = validArtifact();
    artifact.environment.nodeVersion = "v24.4.1";
    artifact.scenarios[0].samplesMs[28] = 2;
    artifact.scenarios[0].samples[28].durationMs = 2;
    artifact.scenarios[0].p95Ms = 1.5;
    const query = artifact.scenarios.find((scenario: any) => scenario.operation === "query-definitions");
    query.samples[0].resultSha256 = "0".repeat(64);
    const failures = verifyArtifact(artifact);
    assert.ok(failures.some((failure) => failure.includes("Node major")));
    assert.ok(failures.some((failure) => failure.includes("p95 is invalid")));
    assert.ok(failures.some((failure) => failure.includes("result hash is invalid")));
  });

  test("rejects smoke output and one-file parse drift", () => {
    const artifact = validArtifact();
    artifact.smoke = true;
    const refresh = artifact.scenarios.find((scenario: any) => scenario.operation === "one-file-edit");
    refresh.samples[0].stats.parsedFiles = 2;
    const failures = verifyArtifact(artifact);
    assert.ok(failures.some((failure) => failure.includes("smoke output")));
    assert.ok(failures.some((failure) => failure.includes("one-file parse count")));
  });

  test("rejects forged status, ensure, and query outcomes", () => {
    const artifact = validArtifact();
    artifact.scenarios.find((scenario: any) => scenario.operation === "exact-status")
      .samples[0].outcome.fresh = false;
    artifact.scenarios.find((scenario: any) => scenario.operation === "full-build")
      .samples[0].outcome.snapshotId = "forged";
    artifact.scenarios.find((scenario: any) => scenario.operation === "query-definitions")
      .samples[0].semanticResult.occurrences[0].path = "src/forged.ts";
    const failures = verifyArtifact(artifact);
    assert.ok(failures.some((failure) => failure.includes("status outcome")));
    assert.ok(failures.some((failure) => failure.includes("ensure outcome")));
    assert.ok(failures.some((failure) => failure.includes("definition result is not canonical")));
  });

  test("rejects a generator hash that does not match the checked-in generator", () => {
    const artifact = validArtifact();
    artifact.generatorSha256 = "e".repeat(64);
    assert.ok(
      verifyArtifact(artifact).some((failure) => failure.includes("checked-in generator")),
    );
  });

  test("rejects unknown schema fields", () => {
    const artifact = validArtifact();
    artifact.unreviewed = true;
    artifact.scenarios[0].samples[0].extra = "forged";
    delete artifact.environment.gitVersion;
    const failures = verifyArtifact(artifact);
    assert.ok(failures.some((failure) => failure.includes("unknown field unreviewed")));
    assert.ok(failures.some((failure) => failure.includes("unknown field extra")));
    assert.ok(failures.some((failure) => failure.includes("missing field gitVersion")));
  });
});
