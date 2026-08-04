#!/usr/bin/env node
/**
 * Canonical Local Code Index v2 benchmark.
 *
 * Parent work (fixture restoration and storage cloning) is deliberately kept
 * outside the timed child operation. Each warm-up and measured run gets a new
 * child process and an isolated CPB root.
 */

import { createHash } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureLocalCodeIndex,
  localCodeIndexStatus,
  queryLocalCodeIndex,
} from "../core/indexing/local-code-index/index.js";
import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";
import type {
  LocalCodeIndexBuildStats,
  LocalCodeIndexQuery,
  LocalCodeIndexRef,
} from "../core/indexing/local-code-index/contracts.js";
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
  type ScenarioDef,
} from "../tests/benchmarks/local-code-index-v2/scenarios.js";
import {
  fixtureRelativePath,
  generateFixture,
  type FixtureManifest,
} from "../tests/benchmarks/local-code-index-v2/generate.js";
import {
  validateBenchmarkArtifact,
  type BenchmarkArtifact,
  type BenchmarkFixtureEvidence,
  type BenchmarkOutcome,
  type BenchmarkSample,
  type BenchmarkScenarioResult,
} from "./validate-local-code-index-v2-benchmark.js";

type WorkerRequest = Readonly<{
  operation: ScenarioDef["operation"];
  sourcePath: string;
  cpbRoot: string;
  ref: LocalCodeIndexRef | null;
  query: LocalCodeIndexQuery | null;
}>;

type WorkerResponse =
  | Readonly<{
      ok: true;
      durationMs: number;
      peakRssBytes: number;
      stats: LocalCodeIndexBuildStats | null;
      semanticResult: unknown;
    }>
  | Readonly<{ ok: false; error: string }>;

type FixtureContext = Readonly<{
  size: FixtureSize;
  sourcePath: string;
  nonGitSourcePath: string;
  baselineCpbRoot: string;
  nonGitBaselineCpbRoot: string;
  baselineRef: LocalCodeIndexRef;
  nonGitBaselineRef: LocalCodeIndexRef;
  manifest: FixtureManifest;
}>;

const DOMAIN_REQUEST = "cpb-local-index-benchmark-request-v1\0";
const DOMAIN_RESULT = "cpb-local-index-benchmark-result-v1\0";

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashCanonical(domain: string, value: unknown): string {
  return sha256Text(domain + canonicalStringify(value).trimEnd());
}

function normalizeQuery(query: LocalCodeIndexQuery): unknown {
  if (query.kind === "related-files") {
    return { ...query, paths: [...query.paths].sort() };
  }
  return query;
}

function semanticResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const { durationMs: _durationMs, ...rest } = value as Record<string, unknown>;
  return rest;
}

function benchmarkOutcome(
  scenario: ScenarioDef,
  value: unknown,
): BenchmarkOutcome {
  if (!value || typeof value !== "object") {
    throw new Error(`${scenario.id}: operation returned no result`);
  }
  const result = value as Record<string, unknown>;
  if (scenario.operation === "exact-status" || scenario.operation === "non-git-status") {
    if (result.available !== true || result.fresh !== true || result.exact !== true) {
      throw new Error(`${scenario.id}: status was not available, fresh, and exact`);
    }
    return { kind: "status", available: true, fresh: true, exact: true };
  }
  if (scenario.query) {
    const count = Array.isArray(result.occurrences)
      ? result.occurrences.length
      : Array.isArray(result.files)
        ? result.files.length
        : null;
    if (
      result.kind !== scenario.query.kind
      || typeof result.snapshotId !== "string"
      || count === null
    ) {
      throw new Error(`${scenario.id}: query result shape is invalid`);
    }
    return {
      kind: "query",
      resultKind: scenario.query.kind,
      snapshotId: result.snapshotId,
      resultCount: count,
    };
  }
  const ref = result.ref as Record<string, unknown> | undefined;
  if (result.available !== true || typeof ref?.snapshotId !== "string") {
    throw new Error(`${scenario.id}: ensure result shape is invalid`);
  }
  return {
    kind: "ensure",
    available: true,
    snapshotId: ref.snapshotId,
  };
}

function peakRssBytes(): number {
  const value = process.resourceUsage().maxRSS;
  return value * 1024;
}

async function runWorker(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    const start = process.hrtime.bigint();
    let stats: LocalCodeIndexBuildStats | null = null;
    let result: unknown;

    switch (request.operation) {
      case "full-build":
      case "unchanged-ensure":
      case "one-file-edit":
      case "hundred-file-edit":
      case "branch-switch": {
        const ensured = await ensureLocalCodeIndex({
          sourcePath: request.sourcePath,
          cpbRoot: request.cpbRoot,
        });
        stats = ensured.stats;
        result = {
          available: ensured.available,
          ref: ensured.ref,
          tool: ensured.tool,
          stats: ensured.stats,
        };
        break;
      }
      case "exact-status":
      case "non-git-status":
        result = await localCodeIndexStatus({
          sourcePath: request.sourcePath,
          cpbRoot: request.cpbRoot,
        });
        break;
      case "query-definitions":
      case "query-references":
      case "query-related-files":
        if (!request.ref || !request.query) throw new Error("query worker input is incomplete");
        result = await queryLocalCodeIndex(
          request.ref,
          request.query,
          { cpbRoot: request.cpbRoot },
        );
        break;
    }

    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    return {
      ok: true,
      durationMs,
      peakRssBytes: peakRssBytes(),
      stats,
      semanticResult: semanticResult(result),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

async function workerMain(): Promise<void> {
  process.once("message", async (message: WorkerRequest) => {
    const response = await runWorker(message);
    if (process.send) process.send(response, () => process.exit(response.ok ? 0 : 1));
  });
}

function runChild(request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--worker"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, CPB_BENCHMARK_CHILD: "1" },
    });
    let settled = false;
    child.once("message", (message: WorkerResponse) => {
      settled = true;
      resolve(message);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!settled) reject(new Error(`benchmark child exited without a result (${String(code)})`));
    });
    child.send(request);
  });
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  }).trim();
}

async function cloneTree(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await cp(source, destination, {
    recursive: true,
    force: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
}

async function cloneWorkingTreeWithoutGit(source: string, destination: string): Promise<void> {
  await rm(destination, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await mkdir(destination, { recursive: true });
  await cp(path.join(source, "src"), path.join(destination, "src"), {
    recursive: true,
    force: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
}

async function resetMain(sourcePath: string): Promise<void> {
  git(sourcePath, ["switch", "-q", "main"]);
  git(sourcePath, ["reset", "-q", "--hard", "main"]);
  git(sourcePath, ["clean", "-q", "-fd"]);
}

async function applyEdit(sourcePath: string, index: number, label: string): Promise<void> {
  const target = path.join(sourcePath, fixtureRelativePath(index));
  const content = await readFile(target, "utf8");
  const replacement = label === "one-file-edit" ? "#" : "=";
  const edited = content.replace("/*-", `/*${replacement}`);
  if (edited === content) throw new Error(`missing deterministic padding in ${target}`);
  await writeFile(target, edited, "utf8");
}

async function prepareSource(context: FixtureContext, scenario: ScenarioDef): Promise<string> {
  if (scenario.repositoryKind === "non-git") return context.nonGitSourcePath;
  if (scenario.operation === "one-file-edit") {
    await resetMain(context.sourcePath);
    await applyEdit(context.sourcePath, 0, "one-file-edit");
  } else if (scenario.operation === "hundred-file-edit") {
    await resetMain(context.sourcePath);
    const edits: Promise<void>[] = [];
    let index = 0;
    while (edits.length < 100) {
      if (index % 10 !== 9) edits.push(applyEdit(context.sourcePath, index, "hundred-file-edit"));
      index++;
    }
    await Promise.all(edits);
  } else if (scenario.operation === "branch-switch") {
    await resetMain(context.sourcePath);
    git(context.sourcePath, ["switch", "-q", "branch-b"]);
  }
  return context.sourcePath;
}

function queryFor(scenario: ScenarioDef): LocalCodeIndexQuery | null {
  if (!scenario.query) return null;
  if (scenario.query.kind === "related-files") {
    return { ...scenario.query, paths: [...scenario.query.paths] };
  }
  return { ...scenario.query };
}

async function prepareCpbRoot(
  context: FixtureContext,
  scenario: ScenarioDef,
  destination: string,
): Promise<void> {
  await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (scenario.operation === "full-build") {
    await mkdir(destination, { recursive: true });
    return;
  }
  const baseline = scenario.repositoryKind === "non-git"
    ? context.nonGitBaselineCpbRoot
    : context.baselineCpbRoot;
  await cloneTree(baseline, destination);
}

function expectedRef(context: FixtureContext, scenario: ScenarioDef): LocalCodeIndexRef | null {
  if (!scenario.query) return null;
  return scenario.repositoryKind === "non-git"
    ? context.nonGitBaselineRef
    : context.baselineRef;
}

function validateSample(
  scenario: ScenarioDef,
  response: Extract<WorkerResponse, { ok: true }>,
): string[] {
  const failures: string[] = [];
  const stats = response.stats;
  const semantic = response.semanticResult as Record<string, unknown>;
  if (scenario.operation === "full-build") {
    if (!stats || stats.mode !== "full") failures.push(`${scenario.id}: full build did not report full mode`);
    if (stats && stats.discoveredFiles !== scenario.fixtureSize) {
      failures.push(`${scenario.id}: full build discovered ${stats.discoveredFiles} files`);
    }
    if (stats && stats.reusedFiles !== 0) failures.push(`${scenario.id}: full build reused files`);
  }
  if (scenario.operation === "one-file-edit" && stats?.parsedFiles !== 1) {
    failures.push(`${scenario.id}: one-file refresh parsed ${String(stats?.parsedFiles)} files`);
  }
  if (scenario.operation === "unchanged-ensure" && stats?.mode !== "reused") {
    failures.push(`${scenario.id}: unchanged ensure did not reuse the snapshot`);
  }
  if (
    (scenario.operation === "exact-status" || scenario.operation === "non-git-status")
    && (!semantic || semantic.available !== true || semantic.fresh !== true || semantic.exact !== true)
  ) {
    failures.push(`${scenario.id}: status was not available, fresh, and exact`);
  }
  return failures;
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

async function runScenario(
  context: FixtureContext,
  scenario: ScenarioDef,
  runsRoot: string,
  warmups: number,
  measured: number,
): Promise<{ result: BenchmarkScenarioResult; failures: string[] }> {
  const samples: BenchmarkSample[] = [];
  const failures: string[] = [];
  const total = warmups + measured;

  for (let run = 0; run < total; run++) {
    const sourcePath = await prepareSource(context, scenario);
    const cpbRoot = path.join(runsRoot, `${scenario.id}-${run}`);
    await prepareCpbRoot(context, scenario, cpbRoot);
    const query = queryFor(scenario);
    const response = await runChild({
      operation: scenario.operation,
      sourcePath,
      cpbRoot,
      ref: expectedRef(context, scenario),
      query,
    });
    await rm(cpbRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    if ("error" in response) {
      failures.push(`${scenario.id} run ${run}: ${response.error}`);
      continue;
    }
    failures.push(...validateSample(scenario, response));
    if (run >= warmups) {
      const outcome = benchmarkOutcome(scenario, response.semanticResult);
      samples.push({
        durationMs: response.durationMs,
        peakRssBytes: response.peakRssBytes,
        stats: response.stats,
        outcome,
        requestSha256: query ? hashCanonical(DOMAIN_REQUEST, normalizeQuery(query)) : null,
        resultSha256: query ? hashCanonical(DOMAIN_RESULT, response.semanticResult) : null,
        semanticResult: query ? response.semanticResult : null,
      });
    }
  }

  await resetMain(context.sourcePath);
  const samplesMs = samples.map((sample) => sample.durationMs);
  const scenarioP95 = samplesMs.length > 0 ? p95(samplesMs) : Number.POSITIVE_INFINITY;
  const peak = samples.reduce((maximum, sample) => Math.max(maximum, sample.peakRssBytes), 0);
  const budget = BUDGETS[scenario.id] ?? null;
  if (samples.length !== measured) failures.push(`${scenario.id}: expected ${measured} measured samples, got ${samples.length}`);
  if (budget !== null && scenarioP95 > budget) {
    failures.push(`${scenario.id}: p95 ${scenarioP95.toFixed(3)} ms exceeds ${budget} ms`);
  }
  if (
    ["one-file-edit", "hundred-file-edit", "branch-switch"].includes(scenario.operation)
    && peak >= MAX_REFRESH_RSS_BYTES
  ) {
    failures.push(`${scenario.id}: peak RSS ${peak} is not below ${MAX_REFRESH_RSS_BYTES}`);
  }

  return {
    result: {
      name: scenario.id,
      repositoryKind: scenario.repositoryKind,
      fixtureSize: scenario.fixtureSize,
      operation: scenario.operation,
      warmupRuns: warmups,
      childRuns: total,
      samplesMs,
      p95Ms: scenarioP95,
      peakRssBytes: peak,
      stats: samples.at(-1)?.stats ?? null,
      samples,
    },
    failures,
  };
}

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function preflight(workRoot: string): Promise<{
  cpuPercent: number;
  freeMemoryBytes: number;
  filesystem: string;
  storageType: "local-ssd";
}> {
  const freeMemoryBytes = freemem();
  if (freeMemoryBytes < 2 * 1024 * 1024 * 1024) {
    throw new Error("benchmark requires at least 2 GiB free RAM");
  }
  const before = cpuTotals();
  await delay(10_000);
  const after = cpuTotals();
  const totalDelta = after.total - before.total;
  const cpuPercent = totalDelta === 0 ? 100 : 100 * (1 - (after.idle - before.idle) / totalDelta);
  if (cpuPercent >= 50) throw new Error(`aggregate CPU use ${cpuPercent.toFixed(2)}% is not below 50%`);

  let filesystem = "unknown";
  let solidState = false;
  if (process.platform === "darwin") {
    filesystem = execFileSync("stat", ["-f", "%T", workRoot], { encoding: "utf8" }).trim();
    // diskutil info requires a volume mount point or disk identifier, not an
    // arbitrary subpath; resolve the work root's mount point via df first.
    const dfRows = execFileSync("df", ["-P", workRoot], { encoding: "utf8" }).trim().split("\n");
    const mountPoint = dfRows[dfRows.length - 1]!.trim().split(/\s+/).pop()!;
    const diskInfo = execFileSync("diskutil", ["info", mountPoint], { encoding: "utf8" });
    solidState = /Solid State:\s+Yes/i.test(diskInfo) && !/Protocol:\s+(SMB|NFS|AFP)/i.test(diskInfo);
  } else if (process.platform === "linux") {
    filesystem = execFileSync("stat", ["-f", "-c", "%T", workRoot], { encoding: "utf8" }).trim();
    const source = execFileSync("findmnt", ["-n", "-o", "SOURCE", "--target", workRoot], { encoding: "utf8" }).trim();
    const device = path.basename(source).replace(/[0-9]+$/, "");
    const rotational = execFileSync("lsblk", ["-dn", "-o", "ROTA", `/dev/${device}`], { encoding: "utf8" }).trim();
    solidState = rotational === "0";
  }
  if (!solidState) throw new Error("benchmark work root is not verified as local SSD storage");
  return { cpuPercent, freeMemoryBytes, filesystem, storageType: "local-ssd" };
}

function commandVersion(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

async function fixtureEvidence(
  size: FixtureSize,
  manifest: FixtureManifest,
): Promise<BenchmarkFixtureEvidence> {
  return {
    ...manifest,
    size,
  };
}

async function createFixtureContext(
  workRoot: string,
  size: FixtureSize,
): Promise<FixtureContext> {
  const sourcePath = path.join(workRoot, "fixtures", `git-${size}`);
  const nonGitSourcePath = path.join(workRoot, "fixtures", `non-git-${size}`);
  const baselineCpbRoot = path.join(workRoot, "baselines", `git-${size}`);
  const nonGitBaselineCpbRoot = path.join(workRoot, "baselines", `non-git-${size}`);
  const manifest = await generateFixture(size, sourcePath);
  await cloneWorkingTreeWithoutGit(sourcePath, nonGitSourcePath);
  await mkdir(baselineCpbRoot, { recursive: true });
  await mkdir(nonGitBaselineCpbRoot, { recursive: true });
  const baseline = await ensureLocalCodeIndex({ sourcePath, cpbRoot: baselineCpbRoot });
  const nonGitBaseline = await ensureLocalCodeIndex({
    sourcePath: nonGitSourcePath,
    cpbRoot: nonGitBaselineCpbRoot,
  });
  return {
    size,
    sourcePath,
    nonGitSourcePath,
    baselineCpbRoot,
    nonGitBaselineCpbRoot,
    baselineRef: baseline.ref,
    nonGitBaselineRef: nonGitBaseline.ref,
    manifest,
  };
}

function parseArgs(argv: readonly string[]): {
  output: string;
  workRoot: string;
  smoke: boolean;
} {
  let output = path.resolve("artifacts/bench/local-code-index-v2.json");
  let workRoot = path.resolve("artifacts/bench/work");
  let smoke = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--output") output = path.resolve(argv[++index] ?? "");
    else if (arg === "--work-root") workRoot = path.resolve(argv[++index] ?? "");
    else if (arg === "--smoke") smoke = true;
    else throw new Error(`unknown benchmark argument: ${arg}`);
  }
  if (!output || !workRoot) throw new Error("--output and --work-root require values");
  return { output, workRoot, smoke };
}

async function main(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(SUPPORTED_NODE_MAJORS as readonly number[]).includes(major)) {
    throw new Error(`benchmark requires Node 20 or 22; current version is ${process.version}`);
  }
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.workRoot, { recursive: true });
  const canonicalWorkRoot = await mkdtemp(path.join(args.workRoot, "run-"));
  const startedAt = new Date().toISOString();
  const preflightResult = args.smoke
    ? {
        cpuPercent: 0,
        freeMemoryBytes: freemem(),
        filesystem: "smoke-unverified",
        storageType: "local-ssd" as const,
      }
    : await preflight(canonicalWorkRoot);
  const warmups = args.smoke ? 0 : WARMUP_RUNS;
  const measured = args.smoke ? 1 : MEASURED_RUNS;
  const failures: string[] = [];

  try {
    const contexts = new Map<FixtureSize, FixtureContext>();
    const fixtures: BenchmarkFixtureEvidence[] = [];
    for (const size of FIXTURE_SIZES) {
      const context = await createFixtureContext(canonicalWorkRoot, size);
      contexts.set(size, context);
      fixtures.push(await fixtureEvidence(size, context.manifest));
    }

    const scenarios: BenchmarkScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      process.stderr.write(`[bench] ${scenario.id}\n`);
      const context = contexts.get(scenario.fixtureSize)!;
      const run = await runScenario(
        context,
        scenario,
        path.join(canonicalWorkRoot, "runs"),
        warmups,
        measured,
      );
      scenarios.push(run.result);
      failures.push(...run.failures);
    }

    const generatorPath = path.resolve("tests/benchmarks/local-code-index-v2/generate.ts");
    const generatorSha256 = createHash("sha256").update(await readFile(generatorPath)).digest("hex");
    const large = fixtures.find((fixture) => fixture.size === 10000)!;
    const artifact: BenchmarkArtifact = {
      schemaVersion: 1,
      harnessCommit: git(process.cwd(), ["rev-parse", "HEAD"]),
      generatorSha256,
      seed: FIXTURE_SEED,
      generatedInventorySha256: large.generatedInventorySha256,
      eligibleFiles: large.eligibleFiles,
      eligibleBytes: large.eligibleBytes,
      gitObjectFormat: large.gitObjectFormat,
      commits: large.commits,
      fixtures,
      environment: {
        os: `${platform()} ${release()}`,
        architecture: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: preflightResult.freeMemoryBytes,
        preflightCpuPercent: preflightResult.cpuPercent,
        storageType: preflightResult.storageType,
        filesystem: preflightResult.filesystem,
        nodeVersion: process.version,
        gitVersion: commandVersion("git", ["--version"]) ?? "unknown",
        astGrepVersion: commandVersion("ast-grep", ["--version"]),
        workRoot: canonicalWorkRoot,
        sameFilesystem: true,
      },
      startedAt,
      completedAt: new Date().toISOString(),
      warmupRuns: warmups,
      measuredRuns: measured,
      smoke: args.smoke,
      scenarios,
      passed: failures.length === 0 && !args.smoke,
      failures,
    };
    const independentFailures = validateBenchmarkArtifact(artifact, { allowSmoke: args.smoke });
    artifact.failures = [...new Set([...artifact.failures, ...independentFailures])];
    artifact.passed = artifact.failures.length === 0 && !args.smoke;

    const output = args.smoke
      ? args.output.replace(/\.json$/u, ".smoke.json")
      : args.output;
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(temporary, canonicalStringify(artifact), "utf8");
    await rename(temporary, output);
    process.stdout.write(`${output}\n`);
    if (!args.smoke && !artifact.passed) process.exitCode = 1;
  } finally {
    try {
      await rm(canonicalWorkRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      process.stderr.write(
        `[bench] cleanup failed for ${canonicalWorkRoot}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

if (process.argv.includes("--worker")) {
  await workerMain();
} else {
  await main();
}
