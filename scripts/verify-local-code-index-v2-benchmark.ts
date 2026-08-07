#!/usr/bin/env node
/**
 * Independent verifier for Local Code Index v2 benchmark evidence.
 *
 * This file intentionally does not import the harness validator or canonical
 * JSON helper. It reconstructs the checks needed to reject forged, incomplete,
 * smoke, malformed-environment, and structurally invalid artifacts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  FIXTURE_SEED,
  FIXTURE_SIZES,
  MEASURED_RUNS,
  SCENARIOS,
  WARMUP_RUNS,
  benchmarkRelatedPaths,
  benchmarkSymbol,
} from "../tests/benchmarks/local-code-index-v2/scenarios.js";
import { fixtureRelativePath } from "../tests/benchmarks/local-code-index-v2/generate.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${canonicalJson(value)}`, "utf8").digest("hex");
}

function isSha(value: unknown, length: number): boolean {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}

function exactP95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(values.length * 0.95) - 1]!;
}

type AnyRecord = Record<string, any>;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
  failures: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  const allowedSet = new Set(allowed);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) failures.push(`${label} has unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in record)) failures.push(`${label} is missing field ${key}`);
  }
}

export function verifyArtifact(input: unknown): string[] {
  const artifact = input as AnyRecord;
  const failures: string[] = [];
  if (!artifact || typeof artifact !== "object") return ["artifact must be an object"];
  rejectUnknownKeys(artifact, [
    "schemaVersion", "harnessCommit", "generatorSha256", "seed",
    "generatedInventorySha256", "eligibleFiles", "eligibleBytes",
    "gitObjectFormat", "commits", "fixtures", "environment", "startedAt",
    "completedAt", "warmupRuns", "measuredRuns", "smoke", "scenarios",
    "passed", "failures",
  ], "artifact", failures);
  rejectUnknownKeys(artifact.environment, [
    "os", "architecture", "cpuModel", "logicalCpuCount", "totalMemoryBytes",
    "freeMemoryBytes", "preflightCpuPercent", "storageType", "filesystem",
    "nodeVersion", "gitVersion", "astGrepVersion", "workRoot",
    "sameFilesystem",
  ], "environment", failures);
  if (artifact.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (artifact.smoke !== false) failures.push("smoke output is not release evidence");
  if (artifact.seed !== FIXTURE_SEED) failures.push("fixture seed is invalid");
  if (!isSha(artifact.generatorSha256, 64)) failures.push("generator SHA-256 is invalid");
  else {
    const generatorPath = path.join(
      REPO_ROOT,
      "tests",
      "benchmarks",
      "local-code-index-v2",
      "generate.ts",
    );
    const actualGeneratorSha256 = createHash("sha256")
      .update(readFileSync(generatorPath))
      .digest("hex");
    if (artifact.generatorSha256 !== actualGeneratorSha256) {
      failures.push("generator SHA-256 does not match the checked-in generator");
    }
  }
  if (!isSha(artifact.harnessCommit, 40) && !isSha(artifact.harnessCommit, 64)) failures.push("harness commit is invalid");
  if (artifact.warmupRuns !== WARMUP_RUNS) failures.push("warm-up count is invalid");
  if (artifact.measuredRuns !== MEASURED_RUNS) failures.push("measured count is invalid");
  if (typeof artifact.environment?.storageType !== "string" || artifact.environment.storageType.length === 0) {
    failures.push("storage type is missing");
  }
  if (typeof artifact.environment?.sameFilesystem !== "boolean") failures.push("sameFilesystem is invalid");
  if (!artifact.environment?.filesystem || typeof artifact.environment.filesystem !== "string") failures.push("filesystem is missing");
  if (!Number.isFinite(artifact.environment?.freeMemoryBytes) || artifact.environment.freeMemoryBytes < 0) {
    failures.push("free RAM measurement is invalid");
  }
  if (!Number.isFinite(artifact.environment?.preflightCpuPercent) || artifact.environment.preflightCpuPercent < 0) {
    failures.push("preflight CPU measurement is invalid");
  }
  if (typeof artifact.environment?.nodeVersion !== "string" || artifact.environment.nodeVersion.length === 0) {
    failures.push("Node version is missing");
  }

  if (!Array.isArray(artifact.fixtures) || artifact.fixtures.length !== 2) {
    failures.push("fixture evidence count is invalid");
  } else {
    for (const size of FIXTURE_SIZES) {
      const fixture = artifact.fixtures.find((entry: AnyRecord) => entry.size === size);
      if (!fixture) {
        failures.push(`missing fixture ${size}`);
        continue;
      }
      rejectUnknownKeys(fixture, [
        "size", "eligibleFiles", "eligibleBytes", "seed",
        "generatedInventorySha256", "generatedContentSha256",
        "gitObjectFormat", "commits", "gitIdentity", "languageDistribution",
      ], `fixture ${size}`, failures);
      if (fixture.eligibleFiles !== size || fixture.eligibleBytes !== size * 4096) failures.push(`${size}: fixture size is invalid`);
      if (fixture.seed !== FIXTURE_SEED) failures.push(`${size}: seed is invalid`);
      if (!isSha(fixture.generatedInventorySha256, 64) || !isSha(fixture.generatedContentSha256, 64)) {
        failures.push(`${size}: fixture hash is invalid`);
      }
      if (fixture.gitObjectFormat !== "sha1") failures.push(`${size}: object format is invalid`);
      if (
        fixture.languageDistribution?.typescript !== size * 0.7
        || fixture.languageDistribution?.javascript !== size * 0.2
        || fixture.languageDistribution?.json !== size * 0.1
      ) failures.push(`${size}: language distribution is invalid`);
      for (const key of ["base", "branchA", "branchB"]) {
        if (!isSha(fixture.commits?.[key], 40)) failures.push(`${size}: ${key} commit is invalid`);
      }
    }
    const large = artifact.fixtures.find((entry: AnyRecord) => entry.size === 10000);
    if (large) {
      if (
        artifact.generatedInventorySha256 !== large.generatedInventorySha256
        || artifact.eligibleFiles !== large.eligibleFiles
        || artifact.eligibleBytes !== large.eligibleBytes
        || canonicalJson(artifact.commits) !== canonicalJson(large.commits)
      ) failures.push("top-level fixture fields do not match the 10000-file fixture");
    }
  }

  if (!Array.isArray(artifact.scenarios) || artifact.scenarios.length !== SCENARIOS.length) {
    failures.push("scenario count is invalid");
  } else {
    for (const definition of SCENARIOS) {
      const scenario = artifact.scenarios.find((entry: AnyRecord) => entry.name === definition.id);
      if (!scenario) {
        failures.push(`missing scenario ${definition.id}`);
        continue;
      }
      rejectUnknownKeys(scenario, [
        "name", "repositoryKind", "fixtureSize", "operation", "warmupRuns",
        "childRuns", "samplesMs", "p95Ms", "peakRssBytes", "stats", "samples",
      ], `scenario ${definition.id}`, failures);
      if (
        scenario.fixtureSize !== definition.fixtureSize
        || scenario.operation !== definition.operation
        || scenario.repositoryKind !== definition.repositoryKind
      ) failures.push(`${definition.id}: identity is invalid`);
      if (scenario.warmupRuns !== WARMUP_RUNS || scenario.childRuns !== WARMUP_RUNS + MEASURED_RUNS) {
        failures.push(`${definition.id}: child process counts are invalid`);
      }
      if (!Array.isArray(scenario.samples) || !Array.isArray(scenario.samplesMs)
        || scenario.samples.length !== MEASURED_RUNS || scenario.samplesMs.length !== MEASURED_RUNS) {
        failures.push(`${definition.id}: sample count is invalid`);
        continue;
      }
      if (scenario.samplesMs.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        failures.push(`${definition.id}: duration is invalid`);
        continue;
      }
      if (scenario.p95Ms !== exactP95(scenario.samplesMs)) failures.push(`${definition.id}: p95 is invalid`);
      const peak = Math.max(...scenario.samples.map((sample: AnyRecord) => sample.peakRssBytes));
      if (scenario.peakRssBytes !== peak) failures.push(`${definition.id}: peak RSS is invalid`);
      const request = definition.query?.kind === "related-files"
        ? { ...definition.query, paths: [...definition.query.paths].sort() }
        : definition.query;
      for (let index = 0; index < scenario.samples.length; index++) {
        const sample = scenario.samples[index] as AnyRecord;
        rejectUnknownKeys(sample, [
          "durationMs", "peakRssBytes", "stats", "outcome", "requestSha256",
          "resultSha256", "semanticResult",
        ], `${definition.id} sample ${index}`, failures);
        rejectUnknownKeys(
          sample.outcome,
          sample.outcome?.kind === "status"
            ? ["kind", "available", "fresh", "exact"]
            : sample.outcome?.kind === "ensure"
              ? ["kind", "available", "snapshotId"]
              : ["kind", "resultKind", "snapshotId", "resultCount"],
          `${definition.id} sample ${index} outcome`,
          failures,
        );
        if (sample.durationMs !== scenario.samplesMs[index]) failures.push(`${definition.id}: sample durations diverge`);
        if (definition.query) {
          const semantic = sample.semanticResult as AnyRecord | null;
          const resultCount = Array.isArray(semantic?.occurrences)
            ? semantic.occurrences.length
            : Array.isArray(semantic?.files)
              ? semantic.files.length
              : null;
          if (
            sample.outcome?.kind !== "query"
            || sample.outcome.resultKind !== definition.query.kind
            || !/^idx2-[0-9a-f]{24}$/u.test(sample.outcome.snapshotId)
            || sample.outcome.resultCount !== resultCount
            || semantic?.kind !== definition.query.kind
            || semantic?.snapshotId !== sample.outcome.snapshotId
          ) failures.push(`${definition.id}: query outcome is invalid`);
          if (sample.requestSha256 !== hash("cpb-local-index-benchmark-request-v1", request)) {
            failures.push(`${definition.id}: request hash is invalid`);
          }
          if (sample.resultSha256 !== hash("cpb-local-index-benchmark-result-v1", sample.semanticResult)) {
            failures.push(`${definition.id}: result hash is invalid`);
          }
          if (definition.query.kind === "definitions") {
            const expectedPath = fixtureRelativePath(definition.fixtureSize / 2);
            const expectedSymbol = benchmarkSymbol(definition.fixtureSize);
            const occurrences = semantic?.occurrences;
            if (
              !Array.isArray(occurrences)
              || occurrences.length !== 1
              || occurrences[0]?.path !== expectedPath
              || occurrences[0]?.symbol !== expectedSymbol
              || occurrences[0]?.role !== "definition"
            ) failures.push(`${definition.id}: definition result is not canonical`);
          } else if (definition.query.kind === "references") {
            const expectedSymbol = benchmarkSymbol(definition.fixtureSize);
            const expectedPaths = new Set(
              Array.from(
                { length: 8 },
                (_, offset) => fixtureRelativePath(definition.fixtureSize / 2 + offset + 1),
              ),
            );
            const occurrences = semantic?.occurrences;
            if (
              !Array.isArray(occurrences)
              || occurrences.length !== 12
              || occurrences.some((entry: AnyRecord) =>
                entry.symbol !== expectedSymbol
                || entry.role !== "reference"
                || !expectedPaths.has(entry.path)
              )
            ) failures.push(`${definition.id}: reference result is not canonical`);
          } else {
            const files = semantic?.files;
            const seeds = new Set(benchmarkRelatedPaths(definition.fixtureSize));
            if (
              !Array.isArray(files)
              || files.length < 1
              || files.length > definition.query.limit
              || files.some((entry: AnyRecord) =>
                typeof entry.path !== "string"
                || seeds.has(entry.path)
                || !Array.isArray(entry.evidence)
                || entry.evidence.length === 0
              )
            ) failures.push(`${definition.id}: related-files result is not canonical`);
          }
        } else if (sample.requestSha256 !== null || sample.resultSha256 !== null || sample.semanticResult !== null) {
          failures.push(`${definition.id}: non-query sample has query evidence`);
        }
        if (
          (definition.operation === "exact-status" || definition.operation === "non-git-status")
          && (
            sample.outcome?.kind !== "status"
            || sample.outcome.available !== true
            || sample.outcome.fresh !== true
            || sample.outcome.exact !== true
          )
        ) failures.push(`${definition.id}: status outcome is invalid`);
        if (
          ["full-build", "unchanged-ensure", "one-file-edit", "hundred-file-edit", "branch-switch"]
            .includes(definition.operation)
          && (
            sample.outcome?.kind !== "ensure"
            || sample.outcome.available !== true
            || !/^idx2-[0-9a-f]{24}$/u.test(sample.outcome.snapshotId)
          )
        ) failures.push(`${definition.id}: ensure outcome is invalid`);
        if (definition.operation === "full-build") {
          if (
            sample.stats?.mode !== "full"
            || sample.stats?.discoveredFiles !== definition.fixtureSize
            || sample.stats?.reusedFiles !== 0
          ) failures.push(`${definition.id}: full-build stats are invalid`);
        }
        if (definition.operation === "one-file-edit" && sample.stats?.parsedFiles !== 1) {
          failures.push(`${definition.id}: one-file parse count is invalid`);
        }
        if (definition.operation === "unchanged-ensure" && sample.stats?.mode !== "reused") {
          failures.push(`${definition.id}: unchanged ensure mode is invalid`);
        }
      }
    }
  }
  if (!Array.isArray(artifact.failures) || artifact.failures.length !== 0) failures.push("artifact contains harness failures");
  if (artifact.passed !== true) failures.push("artifact is not marked passed");
  return [...new Set(failures)];
}

function main(): void {
  const input = path.resolve(process.argv[2] ?? "artifacts/bench/local-code-index-v2.json");
  let artifact: unknown;
  try {
    artifact = JSON.parse(readFileSync(input, "utf8"));
  } catch (error) {
    process.stderr.write(`cannot read benchmark artifact: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const failures = verifyArtifact(artifact);
  if (failures.length > 0) {
    failures.forEach((failure) => process.stderr.write(`${failure}\n`));
    process.exitCode = 1;
  } else {
    process.stdout.write("Local Code Index v2 benchmark artifact is valid.\n");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
