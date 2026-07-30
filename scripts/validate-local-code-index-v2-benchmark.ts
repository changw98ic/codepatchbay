#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";
import type { LocalCodeIndexBuildStats } from "../core/indexing/local-code-index/contracts.js";
import {
  BUDGETS,
  FIXTURE_SEED,
  FIXTURE_SIZES,
  MAX_REFRESH_RSS_BYTES,
  MEASURED_RUNS,
  SCENARIOS,
  SUPPORTED_NODE_MAJORS,
  WARMUP_RUNS,
  type FixtureSize,
  type ScenarioOperation,
} from "../tests/benchmarks/local-code-index-v2/scenarios.js";
import type { FixtureManifest } from "../tests/benchmarks/local-code-index-v2/generate.js";

export type BenchmarkFixtureEvidence = FixtureManifest & Readonly<{ size: FixtureSize }>;

export type BenchmarkOutcome =
  | Readonly<{
      kind: "status";
      available: true;
      fresh: true;
      exact: true;
    }>
  | Readonly<{
      kind: "ensure";
      available: true;
      snapshotId: string;
    }>
  | Readonly<{
      kind: "query";
      resultKind: "definitions" | "references" | "related-files";
      snapshotId: string;
      resultCount: number;
    }>;

export type BenchmarkSample = Readonly<{
  durationMs: number;
  peakRssBytes: number;
  stats: LocalCodeIndexBuildStats | null;
  outcome: BenchmarkOutcome;
  requestSha256: string | null;
  resultSha256: string | null;
  semanticResult: unknown;
}>;

export type BenchmarkScenarioResult = Readonly<{
  name: string;
  repositoryKind: "git" | "non-git";
  fixtureSize: FixtureSize;
  operation: ScenarioOperation;
  warmupRuns: number;
  childRuns: number;
  samplesMs: readonly number[];
  p95Ms: number;
  peakRssBytes: number;
  stats: LocalCodeIndexBuildStats | null;
  samples: readonly BenchmarkSample[];
}>;

export type BenchmarkArtifact = {
  schemaVersion: 1;
  harnessCommit: string;
  generatorSha256: string;
  seed: string;
  generatedInventorySha256: string;
  eligibleFiles: number;
  eligibleBytes: number;
  gitObjectFormat: "sha1" | "sha256";
  commits: Readonly<{ base: string; branchA: string; branchB: string }>;
  fixtures: readonly BenchmarkFixtureEvidence[];
  environment: Readonly<{
    os: string;
    architecture: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    preflightCpuPercent: number;
    storageType: "local-ssd";
    filesystem: string;
    nodeVersion: string;
    gitVersion: string;
    astGrepVersion: string | null;
    workRoot: string;
    sameFilesystem: boolean;
  }>;
  startedAt: string;
  completedAt: string;
  warmupRuns: number;
  measuredRuns: number;
  smoke: boolean;
  scenarios: readonly BenchmarkScenarioResult[];
  passed: boolean;
  failures: readonly string[];
};

const DOMAIN_REQUEST = "cpb-local-index-benchmark-request-v1\0";
const DOMAIN_RESULT = "cpb-local-index-benchmark-result-v1\0";

function sha256Canonical(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain + canonicalStringify(value).trimEnd(), "utf8")
    .digest("hex");
}

function exactP95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

function expectedRequest(scenario: (typeof SCENARIOS)[number]): unknown {
  if (!scenario.query) return null;
  if (scenario.query.kind === "related-files") {
    return { ...scenario.query, paths: [...scenario.query.paths].sort() };
  }
  return scenario.query;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function semanticCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (Array.isArray(result.occurrences)) return result.occurrences.length;
  if (Array.isArray(result.files)) return result.files.length;
  return null;
}

export function validateBenchmarkArtifact(
  artifact: BenchmarkArtifact,
  options: Readonly<{ allowSmoke?: boolean }> = {},
): string[] {
  const failures: string[] = [];
  const smokeAllowed = options.allowSmoke === true && artifact.smoke === true;
  if (artifact.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (!isSha256(artifact.generatorSha256)) failures.push("generatorSha256 is invalid");
  if (artifact.seed !== FIXTURE_SEED) failures.push("fixture seed is invalid");
  if (!/^[0-9a-f]{40,64}$/u.test(artifact.harnessCommit)) failures.push("harnessCommit is invalid");
  if (artifact.environment.storageType !== "local-ssd") failures.push("storage is not verified local SSD");
  if (!artifact.environment.sameFilesystem) failures.push("fixture and index roots are not on one filesystem");
  if (!artifact.environment.filesystem || artifact.environment.filesystem === "unknown") {
    failures.push("filesystem is not reported");
  }
  const nodeMajor = Number(/^v?(\d+)/u.exec(artifact.environment.nodeVersion)?.[1]);
  if (!(SUPPORTED_NODE_MAJORS as readonly number[]).includes(nodeMajor)) {
    failures.push("Node major must be 20 or 22");
  }
  if (artifact.environment.freeMemoryBytes < 2 * 1024 * 1024 * 1024) {
    failures.push("free memory was below 2 GiB");
  }
  if (artifact.environment.preflightCpuPercent >= 20) failures.push("preflight CPU was not below 20%");
  if (!smokeAllowed && artifact.smoke) failures.push("smoke output is not release evidence");
  if (!smokeAllowed && artifact.warmupRuns !== WARMUP_RUNS) failures.push("warm-up run count is invalid");
  if (!smokeAllowed && artifact.measuredRuns !== MEASURED_RUNS) failures.push("measured run count is invalid");

  if (artifact.fixtures.length !== FIXTURE_SIZES.length) failures.push("fixture evidence count is invalid");
  for (const size of FIXTURE_SIZES) {
    const fixture = artifact.fixtures.find((entry) => entry.size === size);
    if (!fixture) {
      failures.push(`missing fixture evidence for ${size}`);
      continue;
    }
    if (fixture.eligibleFiles !== size) failures.push(`${size}: eligible file count is invalid`);
    if (fixture.eligibleBytes !== size * 4096) failures.push(`${size}: eligible byte count is invalid`);
    if (fixture.seed !== FIXTURE_SEED) failures.push(`${size}: seed is invalid`);
    if (!isSha256(fixture.generatedInventorySha256)) failures.push(`${size}: inventory hash is invalid`);
    if (!isSha256(fixture.generatedContentSha256)) failures.push(`${size}: content hash is invalid`);
    if (fixture.gitObjectFormat !== "sha1") failures.push(`${size}: Git object format is invalid`);
    if (
      fixture.languageDistribution.typescript !== size * 0.7
      || fixture.languageDistribution.javascript !== size * 0.2
      || fixture.languageDistribution.json !== size * 0.1
    ) failures.push(`${size}: language distribution is invalid`);
    for (const [name, commit] of Object.entries(fixture.commits)) {
      if (!/^[0-9a-f]{40}$/u.test(commit)) failures.push(`${size}: ${name} commit is invalid`);
    }
  }
  const large = artifact.fixtures.find((fixture) => fixture.size === 10000);
  if (large) {
    if (artifact.generatedInventorySha256 !== large.generatedInventorySha256) failures.push("top-level inventory hash does not match 10000-file fixture");
    if (artifact.eligibleFiles !== large.eligibleFiles) failures.push("top-level eligibleFiles does not match 10000-file fixture");
    if (artifact.eligibleBytes !== large.eligibleBytes) failures.push("top-level eligibleBytes does not match 10000-file fixture");
    if (canonicalStringify(artifact.commits) !== canonicalStringify(large.commits)) failures.push("top-level commits do not match 10000-file fixture");
  }

  if (artifact.scenarios.length !== SCENARIOS.length) failures.push("scenario count is invalid");
  for (const definition of SCENARIOS) {
    const scenario = artifact.scenarios.find((entry) => entry.name === definition.id);
    if (!scenario) {
      failures.push(`missing scenario ${definition.id}`);
      continue;
    }
    if (
      scenario.repositoryKind !== definition.repositoryKind
      || scenario.fixtureSize !== definition.fixtureSize
      || scenario.operation !== definition.operation
    ) failures.push(`${definition.id}: scenario identity is invalid`);
    const expectedMeasured = smokeAllowed ? artifact.measuredRuns : MEASURED_RUNS;
    const expectedWarmups = smokeAllowed ? artifact.warmupRuns : WARMUP_RUNS;
    if (scenario.samples.length !== expectedMeasured || scenario.samplesMs.length !== expectedMeasured) {
      failures.push(`${definition.id}: sample count is invalid`);
      continue;
    }
    if (scenario.warmupRuns !== expectedWarmups) failures.push(`${definition.id}: warm-up count is invalid`);
    if (scenario.childRuns !== expectedMeasured + expectedWarmups) failures.push(`${definition.id}: child run count is invalid`);
    if (scenario.samples.some((sample, index) => sample.durationMs !== scenario.samplesMs[index])) {
      failures.push(`${definition.id}: samplesMs diverges from sample records`);
    }
    if (scenario.samplesMs.some((value) => !Number.isFinite(value) || value < 0)) {
      failures.push(`${definition.id}: duration is invalid`);
    } else if (scenario.p95Ms !== exactP95(scenario.samplesMs)) {
      failures.push(`${definition.id}: p95 is not the exact nearest-rank item`);
    }
    const exactPeak = scenario.samples.reduce((maximum, sample) => Math.max(maximum, sample.peakRssBytes), 0);
    if (scenario.peakRssBytes !== exactPeak) failures.push(`${definition.id}: peak RSS is invalid`);
    const budget = BUDGETS[definition.id];
    if (!smokeAllowed && budget !== undefined && scenario.p95Ms > budget) {
      failures.push(`${definition.id}: p95 exceeds ${budget} ms`);
    }
    if (
      ["one-file-edit", "hundred-file-edit", "branch-switch"].includes(definition.operation)
      && scenario.peakRssBytes >= MAX_REFRESH_RSS_BYTES
    ) failures.push(`${definition.id}: refresh peak RSS is too high`);

    const request = expectedRequest(definition);
    for (const sample of scenario.samples) {
      if (definition.query) {
        const queryOutcome = sample.outcome.kind === "query"
          ? sample.outcome
          : null;
        if (
          !queryOutcome
          || queryOutcome.resultKind !== definition.query.kind
          || !/^idx2-[0-9a-f]{24}$/u.test(queryOutcome.snapshotId)
          || queryOutcome.resultCount !== semanticCount(sample.semanticResult)
        ) {
          failures.push(`${definition.id}: query outcome is invalid`);
        }
        const semantic = sample.semanticResult as Record<string, unknown> | null;
        if (
          !semantic
          || semantic.kind !== definition.query.kind
          || semantic.snapshotId !== queryOutcome?.snapshotId
        ) failures.push(`${definition.id}: query semantic result is invalid`);
        if (sample.requestSha256 !== sha256Canonical(DOMAIN_REQUEST, request)) {
          failures.push(`${definition.id}: query request hash is invalid`);
        }
        if (sample.resultSha256 !== sha256Canonical(DOMAIN_RESULT, sample.semanticResult)) {
          failures.push(`${definition.id}: query result hash is invalid`);
        }
      } else if (sample.requestSha256 !== null || sample.resultSha256 !== null || sample.semanticResult !== null) {
        failures.push(`${definition.id}: non-query sample contains query evidence`);
      }
      if (
        (definition.operation === "exact-status" || definition.operation === "non-git-status")
        && (
          sample.outcome.kind !== "status"
          || sample.outcome.available !== true
          || sample.outcome.fresh !== true
          || sample.outcome.exact !== true
        )
      ) failures.push(`${definition.id}: status outcome is invalid`);
      if (
        ["full-build", "unchanged-ensure", "one-file-edit", "hundred-file-edit", "branch-switch"]
          .includes(definition.operation)
        && (
          sample.outcome.kind !== "ensure"
          || sample.outcome.available !== true
          || !/^idx2-[0-9a-f]{24}$/u.test(sample.outcome.snapshotId)
        )
      ) failures.push(`${definition.id}: ensure outcome is invalid`);
      if (definition.operation === "full-build") {
        if (!sample.stats || sample.stats.mode !== "full" || sample.stats.discoveredFiles !== definition.fixtureSize || sample.stats.reusedFiles !== 0) {
          failures.push(`${definition.id}: full-build stats are invalid`);
        }
      }
      if (definition.operation === "one-file-edit" && sample.stats?.parsedFiles !== 1) {
        failures.push(`${definition.id}: one-file edit did not parse exactly one file`);
      }
      if (definition.operation === "unchanged-ensure" && sample.stats?.mode !== "reused") {
        failures.push(`${definition.id}: unchanged ensure was not reused`);
      }
    }
  }
  for (const scenario of artifact.scenarios) {
    if (!SCENARIOS.some((definition) => definition.id === scenario.name)) {
      failures.push(`unexpected scenario ${scenario.name}`);
    }
  }
  if (artifact.failures.length > 0) failures.push(...artifact.failures.map((failure) => `harness: ${failure}`));
  if (!smokeAllowed && artifact.passed !== (failures.length === 0)) failures.push("passed flag does not match validation result");
  return [...new Set(failures)];
}

async function main(): Promise<void> {
  const input = path.resolve(process.argv[2] ?? "artifacts/bench/local-code-index-v2.json");
  const artifact = JSON.parse(await readFile(input, "utf8")) as BenchmarkArtifact;
  const failures = validateBenchmarkArtifact(artifact);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Local Code Index v2 benchmark artifact is valid.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
