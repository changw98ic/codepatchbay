// ── infra.ts — merged: local-smoke, lease-manager, concurrency-limits, process-registry, index-freshness ──

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type LooseRecord } from "../../core/contracts/types.js";
import { openPinnedHubRedisStateBackend, type HubRedisStateBackend } from "../../shared/hub-state-redis.js";

const execFileAsync = promisify(execFile);

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function recordValue(value: unknown): LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as LooseRecord : {};
}

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type RuntimeStorageOptions = LooseRecord & {
  dataRoot?: string;
  includeLegacyFallback?: boolean;
};

type LeaseLockOptions = {
  lockTtlMs?: unknown;
};

type LeaseRecord = LooseRecord & {
  leaseId?: string;
  jobId?: string;
  phase?: string;
  ownerPid?: number;
  ownerHost?: string;
  ownerToken?: string;
  acquiredAt?: string;
  heartbeatAt?: string;
  expiresAt?: string;
  expiresAtMs?: number;
};

type AcquireLeaseOptions = RuntimeStorageOptions & {
  leaseId: string;
  jobId: string;
  phase: string;
  ttlMs: number;
  now?: Date;
  ownerPid?: number;
  lockTtlMs?: unknown;
};

type RenewLeaseOptions = RuntimeStorageOptions & {
  ttlMs: number;
  now?: Date;
  ownerToken?: string;
  lockTtlMs?: unknown;
};

type ReleaseLeaseOptions = RuntimeStorageOptions & {
  ownerToken?: string;
  lockTtlMs?: unknown;
};

type ProcessRegistryOptions = RuntimeStorageOptions & {
  dryRun?: boolean;
};

type ProcessEntry = LooseRecord & {
  jobId?: string;
  project?: string | null;
  phase?: string | null;
  runnerPid?: number;
  treeId?: string | null;
  childPids?: number[];
  leaseId?: string | null;
  startedAt?: string;
  lastHeartbeat?: string;
  status?: string;
  exitCode?: number | null;
  command?: string | null;
  cwd?: string | null;
  executorRoot?: string | null;
  sessionPin?: LooseRecord & {
    sessionId?: string;
    phase?: string;
  };
};

type RegisterProcessOptions = ProcessRegistryOptions & Partial<ProcessEntry>;

type MarkExitedOptions = ProcessRegistryOptions & {
  exitCode?: number | null;
  status?: string;
};

type JobLike = LooseRecord & {
  jobId?: string;
  project?: string | null;
  worktree?: string | null;
  lineage?: LooseRecord & {
    parentJobId?: string | null;
  };
};

type IndexProject = LooseRecord & {
  id?: string;
  name?: string;
  sourcePath?: string;
  projectRoot?: string;
  projectRuntimeRoot?: string;
  metadata?: LooseRecord;
};

type IndexManifest = LooseRecord & {
  schemaVersion?: number;
  sourcePath?: string;
  branch?: string;
  gitHead?: string;
  worktreeStatusHash?: string;
  fileInventoryHash?: string;
  importantConfigHash?: string;
  indexedAt?: string;
  indexSnapshotId?: string;
};

type IndexFreshnessResult = LooseRecord & {
  available?: boolean;
  worktreeDirty: boolean;
  indexDirty: boolean;
  indexStale: boolean;
  dirtyReasons: string[];
  manifest: IndexManifest | null;
  indexSnapshotId?: string | null;
  sourceFingerprint?: LooseRecord | null;
  error?: string;
};

type GetProjectFn = (hubRoot: string, projectId: string) => Promise<LooseRecord | null>;

type ResolveProjectConcurrencyOptions = {
  maxActivePerProject?: unknown;
  getProjectFn?: GetProjectFn | null;
};

// ── local-smoke (from local-smoke.ts) ──────────────────────────────────────

const __dirnameLocal = path.dirname(new URL(import.meta.url).pathname);

const PLAN_PROMPT_RE = "software planning agent";
const EXECUTE_PROMPT_RE = "software execution agent";
const REVIEW_PROMPT_RE = "code review agent";
const VERIFY_PROMPT_RE = "software verification agent";

function jsonEnvelope(data: LooseRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

async function runCommand(command: string, args: string[], opts: CommandOptions = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs || 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const error = recordValue(err);
    const stdout = String(error.stdout || "");
    const stderr = String(error.stderr || "");
    const message = [
      `command failed: ${command} ${args.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
      errorMessage(err),
    ].filter(Boolean).join("\n");
    throw new Error(message);
  }
}

async function withProcessEnv(env: Record<string, string>, fn: () => Promise<unknown>) {
  const previous = new Map();
  for (const key of Object.keys(env)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeTestAgentScenario(tmpRoot: string) {
  const scenarioPath = path.join(tmpRoot, "test-acp-scenario.json");
  await writeFile(
    scenarioPath,
    `${JSON.stringify({
      responses: [
        {
          name: "plan",
          matchRegex: PLAN_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            planMarkdown: "## Analysis\n- Exercise CPB's full fake ACP chain through the registered fake-acp agent.\n\n## Bounded Handoff\n- Real actors: fake ACP provider chain and README.md smoke target\n- Entrypoints: registered fake-acp smoke workflow\n- Bypass candidates: plan, execute, review, and verify phase adapters\n- Edit files: README.md (smoke target only)\n- Verification targets: fake ACP smoke artifact persistence checks\n- Blockers: none\n\n## Files to modify\n- README.md (smoke target only)\n\n## Implementation Steps\n1. Use the deterministic fake ACP provider.\n2. Return JSON envelopes for plan, execute, review, and verify phases.\n3. Let CPB persist every phase artifact.\n\n## Testing\n- Confirm CPB creates plan, deliverable, review, and verdict artifacts.\n\n## Risks\n- This smoke proves orchestration and ACP transport, not real provider quality.",
          }),
        },
        {
          name: "execute",
          matchRegex: EXECUTE_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            summary: "Fake ACP executed the smoke path and intentionally left README.md unchanged.",
            tests: ["server/services/local-smoke.js: fake-acp full-chain smoke reached execute"],
            risks: ["No production source changes are expected in this smoke."],
          }),
        },
        {
          name: "review",
          matchRegex: REVIEW_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            verdict: "approved",
            summary: "Fake ACP smoke review approved the deterministic deliverable.",
            comments: [],
          }),
        },
        {
          name: "verify",
          matchRegex: VERIFY_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "Fake ACP local smoke passed.",
            details: "The registered fake-acp agent completed plan, execute, review, and verify contracts through CPB.",
            confidence: 1,
          }),
        },
      ],
      default: {
        output: "fake-acp no matching artifact path",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return scenarioPath;
}

async function listMarkdownFiles(dir: string) {
  try {
    return (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function collectArtifacts(cpbRoot: string, project: string) {
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const inboxDir = path.join(wikiDir, "inbox");
  const outputsDir = path.join(wikiDir, "outputs");
  return {
    inbox: await listMarkdownFiles(inboxDir),
    outputs: await listMarkdownFiles(outputsDir),
  };
}

async function collectTranscriptEvents(transcriptFile: string) {
  try {
    const raw = await readFile(transcriptFile, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function assertArtifacts(artifacts: Record<string, string[]>) {
  const required = {
    plan: artifacts.inbox.some((entry: string) => /^plan-\d+\.md$/.test(entry)),
    deliverable: artifacts.outputs.some((entry: string) => /^deliverable-\d+\.md$/.test(entry)),
    review: artifacts.outputs.some((entry: string) => /^review-\d+\.md$/.test(entry)),
    verdict: artifacts.outputs.some((entry: string) => /^verdict-\d+\.md$/.test(entry)),
  };
  const missing = Object.entries(required).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`fake ACP smoke missing artifacts: ${missing.join(", ")}`);
  }
}

export async function runFakeAcpSmoke({
  executorRoot = path.resolve(__dirnameLocal, "..", ".."),
  keepTemp = false,
  project = "local-smoke",
  codegraph = false,
} = {}) {
  const root = path.resolve(executorRoot);
  const tmpRoot = await mkdtemp(path.join((await import("node:os")).default.tmpdir(), "cpb-local-smoke-"));
  const cpbRoot = path.join(tmpRoot, "cpb-root");
  const hubRoot = path.join(tmpRoot, "hub");
  const sourcePath = path.join(tmpRoot, "source-project");
  const scenarioFile = await writeTestAgentScenario(tmpRoot);
  const transcriptFile = path.join(tmpRoot, "test-acp-transcript.jsonl");
  const testAgentPath = path.join(root, "tests", "fixtures", "test-acp-agent.js");
  const testAgentArgs = JSON.stringify([testAgentPath, "--scenario-file", scenarioFile, "--transcript-file", transcriptFile]);

  try {
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "README.md"), "# Local Smoke Project\n", "utf8");
    await writeFile(
      path.join(sourcePath, "package.json"),
      `${JSON.stringify({ name: "cpb-local-smoke-project", private: true }, null, 2)}\n`,
      "utf8",
    );

    const env = {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: root,
      CPB_HUB_ROOT: hubRoot,
      CPB_PROJECT_ROOTS: tmpRoot,
      CPB_ACP_USE_MANAGED_POOL: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_TIMEOUT_MS: "30000",
      CPB_ACP_PHASE_TIMEOUT_MS: "30000",
      CPB_ACP_POOL_TIMEOUT_MS: "30000",
      CPB_PHASE_RETRY_MAX: "0",
      CPB_PHASE_FEEDBACK_RETRY_MAX: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: testAgentArgs,
      CPB_USE_WORKTREE: "0",
      ...(codegraph ? {} : { CPB_CODEGRAPH_ENABLED: "0" }),
    };

    const cli = path.join(root, "cli", "cpb.js");
    await runCommand(process.execPath, [cli, "init", sourcePath, project], { cwd: root, env });
    await runCommand(process.execPath, [cli, "attach", sourcePath, project], { cwd: root, env });
    const { writeProjectAgents } = await import("./agent/agent-config.js");
    await writeProjectAgents(cpbRoot, project, {
      default: "fake-acp",
      phases: { plan: "fake-acp", execute: "fake-acp", review: "fake-acp", verify: "fake-acp" },
    });
    await withProcessEnv(env, async () => {
      const { runJobWithServices } = await import("./engine-runner.js");
      return runJobWithServices({
        cpbRoot,
        hubRoot,
        project,
        task: "local fake ACP smoke",
        jobId: "job-local-smoke-001",
        workflow: "complex",
        sourcePath,
        maxRetries: 1,
        agents: { planner: "fake-acp", executor: "fake-acp", reviewer: "fake-acp", verifier: "fake-acp" },
        env,
      });
    });

    const artifacts = await collectArtifacts(cpbRoot, project);
    assertArtifacts(artifacts);

    const verdictName = artifacts.outputs.find((entry) => /^verdict-\d+\.md$/.test(entry));
    const verdictPath = path.join(cpbRoot, "wiki", "projects", project, "outputs", verdictName);
    const verdictContent = await readFile(verdictPath, "utf8");
    if (!/^## Status\s+PASS\b/m.test(verdictContent)) {
      throw new Error(`fake ACP smoke verdict was not pass: ${verdictContent.slice(0, 200)}`);
    }

    const transcriptEvents = await collectTranscriptEvents(transcriptFile);
    if (codegraph) {
      const codegraphSession = transcriptEvents.find((event: LooseRecord) =>
        event.event === "session/new" &&
        Array.isArray(event.mcpServers) &&
        event.mcpServers.some((server) => recordValue(server).name === "codegraph")
      );
      if (!codegraphSession) {
        throw new Error("fake ACP smoke did not receive codegraph MCP server in session/new");
      }
    }

    return {
      ok: true,
      name: "fake-acp-smoke",
      project,
      cpbRoot,
      hubRoot,
      sourcePath,
      artifacts,
      codegraph: {
        enabled: Boolean(codegraph),
        sessionsWithMcp: transcriptEvents.filter((event: LooseRecord) => event.event === "session/new" && Array.isArray(event.mcpServers) && event.mcpServers.length > 0).length,
      },
      keptTemp: keepTemp,
    };
  } finally {
    if (!keepTemp) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

// ── lease-manager (from lease-manager.ts) ──────────────────────────────────

export const LEASE_FORMAT_VERSION = 1;

function leaseBase(cpbRoot: string, opts: RuntimeStorageOptions) {
  if (opts?.dataRoot) return path.resolve(opts.dataRoot);
  if (opts?.includeLegacyFallback === true) return path.join(path.resolve(cpbRoot), "cpb-task");
  throw new Error("project runtime root required for lease storage");
}

const ownedLeaseTokens = new Map<string, string>();
const DEFAULT_LOCK_TTL_MS = 30_000;

function validateLeaseId(leaseId: unknown) {
  if (
    typeof leaseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(leaseId)
  ) {
    throw new Error("invalid leaseId");
  }
}

function leaseFileFor(cpbRoot: string, leaseId: string, opts: RuntimeStorageOptions = {}) {
  validateLeaseId(leaseId);

  const leasesRoot = path.join(leaseBase(cpbRoot, opts), "leases");
  const file = path.resolve(leasesRoot, `${leaseId}.json`);
  const relative = path.relative(leasesRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lease file resolves outside leases root");
  }

  return file;
}

function redisLeaseField(leaseId: string) {
  validateLeaseId(leaseId);
  return `lease:${Buffer.from(leaseId, "utf8").toString("base64url")}`;
}

async function redisLeaseBackend(): Promise<HubRedisStateBackend | null> {
  const hubRoot = process.env.CPB_HUB_ROOT;
  const configFile = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  if (!hubRoot || !configFile) return null;
  return await openPinnedHubRedisStateBackend({ configFile, hubRoot });
}

async function assertNoLocalLeaseState(cpbRoot: string, opts: RuntimeStorageOptions) {
  const root = path.join(leaseBase(cpbRoot, opts), "leases");
  const entries = await readdir(root).catch((): string[] => []);
  if (entries.some((entry) => entry.endsWith(".json"))) {
    throw Object.assign(new Error("local leases require an explicit Redis migration"), {
      code: "HUB_LEASE_MIGRATION_REQUIRED",
    });
  }
}

function parseRedisLease(value: unknown, leaseId: string): LeaseRecord | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`invalid Redis lease: ${leaseId}`), { code: "HUB_STATE_RECORD_INVALID" });
  }
  const lease = value as LeaseRecord;
  if (lease.leaseId !== leaseId || typeof lease.ownerToken !== "string"
    || !Number.isSafeInteger(lease.expiresAtMs) || Number(lease.expiresAtMs) < 0) {
    throw Object.assign(new Error(`invalid Redis lease: ${leaseId}`), { code: "HUB_STATE_RECORD_INVALID" });
  }
  return lease;
}

function expiresAtFor(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function leaseTokenKey(cpbRoot: string, leaseId: string) {
  return `${path.resolve(cpbRoot)}\0${leaseId}`;
}

function rememberOwnerToken(cpbRoot: string, leaseId: string, ownerToken: string) {
  ownedLeaseTokens.set(leaseTokenKey(cpbRoot, leaseId), ownerToken);
}

function forgetOwnerToken(cpbRoot: string, leaseId: string, ownerToken: string) {
  const key = leaseTokenKey(cpbRoot, leaseId);
  if (ownedLeaseTokens.get(key) === ownerToken) {
    ownedLeaseTokens.delete(key);
  }
}

function leaseOwnerTokenFor(cpbRoot: string, leaseId: string, suppliedToken: string | undefined) {
  return suppliedToken ?? ownedLeaseTokens.get(leaseTokenKey(cpbRoot, leaseId));
}

function assertLeaseOwner(lease: LeaseRecord, ownerToken: string | undefined) {
  if (lease.ownerToken !== undefined && lease.ownerToken !== ownerToken) {
    throw new Error("lease owner mismatch");
  }
}

async function atomicWriteJson(file: string, value: unknown) {
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );

  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

async function readLeaseFile(file: string): Promise<LeaseRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LeaseRecord;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function lockTtlMsFor(lockTtlMs: unknown): number {
  if (lockTtlMs !== undefined) {
    return Number(lockTtlMs);
  }

  const fromEnv = Number.parseInt(process.env.CPB_LEASE_LOCK_TTL_MS ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_LOCK_TTL_MS;
}

async function isLockStale(lockDir: string, lockTtlMs: number) {
  const nowMs = Date.now();

  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    const acquiredAtMs = new Date(lock.acquiredAt).getTime();
    return Number.isNaN(acquiredAtMs) || nowMs - acquiredAtMs >= lockTtlMs;
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      return true;
    }
  }

  try {
    const lockStat = await stat(lockDir);
    return nowMs - lockStat.mtimeMs >= lockTtlMs;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    return true;
  }
}

async function writeLockMetadata(lockDir: string) {
  await writeFile(
    path.join(lockDir, "lock.json"),
    `${JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        ownerPid: process.pid,
        ownerHost: hostname(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function acquireLeaseFileLock(file: string, { lockTtlMs }: LeaseLockOptions = {}) {
  const lockDir = `${file}.lock`;
  let acquired = false;
  const effectiveLockTtlMs = lockTtlMsFor(lockTtlMs);

  await mkdir(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeLockMetadata(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }

      if (await isLockStale(lockDir, effectiveLockTtlMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) {
    throw new Error(`lease lock busy: ${path.basename(file)}`);
  }

  return async () => {
    await rm(lockDir, { recursive: true, force: true });
  };
}

async function withLeaseLock<T>(file: string, callback: () => Promise<T>, { lockTtlMs }: LeaseLockOptions = {}): Promise<T> {
  const releaseLock = await acquireLeaseFileLock(file, { lockTtlMs });
  try {
    return await callback();
  } finally {
    await releaseLock();
  }
}

function createLease({
  leaseId,
  jobId,
  phase,
  ttlMs,
  now,
  ownerPid,
  ownerToken = randomUUID(),
}: {
  leaseId: string;
  jobId: string;
  phase: string;
  ttlMs: number;
  now: Date;
  ownerPid: number;
  ownerToken?: string;
}): LeaseRecord {
  const timestamp = now.toISOString();
  return {
    leaseId,
    jobId,
    phase,
    ownerPid,
    ownerHost: hostname(),
    ownerToken,
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: expiresAtFor(now, ttlMs),
  };
}

export async function acquireLease(
  cpbRoot: string,
  {
    leaseId,
    jobId,
    phase,
    ttlMs,
    now = new Date(),
    ownerPid = process.pid,
    lockTtlMs,
    dataRoot,
    includeLegacyFallback = false,
  }: AcquireLeaseOptions
) {
  const redis = await redisLeaseBackend();
  if (redis) {
    await assertNoLocalLeaseState(cpbRoot, { dataRoot, includeLegacyFallback });
    const field = redisLeaseField(leaseId);
    const ownerToken = randomUUID();
    for (let retry = 0; retry < 64; retry += 1) {
      const [snapshot, nowMs] = await Promise.all([redis.readStateRecord(field), redis.serverTimeMs()]);
      const existing = parseRedisLease(snapshot.data, leaseId);
      if (existing && Number(existing.expiresAtMs) > nowMs) {
        throw Object.assign(new Error(`lease already exists: ${leaseId}`), { code: "EEXIST" });
      }
      const timestamp = new Date(nowMs).toISOString();
      const lease: LeaseRecord = {
        leaseId, jobId, phase, ownerPid, ownerHost: hostname(), ownerToken,
        acquiredAt: timestamp, heartbeatAt: timestamp,
        expiresAtMs: nowMs + ttlMs,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      const committed = await redis.compareAndSwapStateRecord(field, snapshot.revision, lease);
      if (committed.committed) {
        rememberOwnerToken(cpbRoot, leaseId, ownerToken);
        return lease;
      }
    }
    throw Object.assign(new Error(`lease changed too frequently: ${leaseId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }
  const file = leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
  const lease = createLease({
    leaseId,
    jobId,
    phase,
    ttlMs,
    now,
    ownerPid,
  });

  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(lease, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    rememberOwnerToken(cpbRoot, leaseId, lease.ownerToken);
    return lease;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }

  const releaseLock = await acquireLeaseFileLock(file, { lockTtlMs });
  try {
    const existing = await readLeaseFile(file);
    if (existing !== null && !isLeaseStale(existing, now)) {
      const err = Object.assign(new Error(`lease already exists: ${leaseId}`), { code: "EEXIST" });
      throw err;
    }

    await atomicWriteJson(file, lease);
    rememberOwnerToken(cpbRoot, leaseId, lease.ownerToken);
    return lease;
  } finally {
    await releaseLock();
  }
}

export async function readLease(cpbRoot: string, leaseId: string, { dataRoot, includeLegacyFallback = false }: RuntimeStorageOptions = {}) {
  const redis = await redisLeaseBackend();
  if (redis) {
    await assertNoLocalLeaseState(cpbRoot, { dataRoot, includeLegacyFallback });
    return parseRedisLease((await redis.readStateRecord(redisLeaseField(leaseId))).data, leaseId);
  }
  return await readLeaseFile(leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback }));
}

export function isLeaseStale(lease: LeaseRecord | null, now = new Date()) {
  if (
    lease === null ||
    typeof lease !== "object" ||
    typeof lease.expiresAt !== "string"
  ) {
    throw new Error("invalid lease");
  }

  const expiresAtMs = new Date(lease.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }

  return expiresAtMs <= now.getTime();
}

export async function renewLease(
  cpbRoot: string,
  leaseId: string,
  { ttlMs, now = new Date(), ownerToken, lockTtlMs, dataRoot, includeLegacyFallback = false }: RenewLeaseOptions
) {
  const redis = await redisLeaseBackend();
  if (redis) {
    await assertNoLocalLeaseState(cpbRoot, { dataRoot, includeLegacyFallback });
    const field = redisLeaseField(leaseId);
    for (let retry = 0; retry < 64; retry += 1) {
      const [snapshot, nowMs] = await Promise.all([redis.readStateRecord(field), redis.serverTimeMs()]);
      const existing = parseRedisLease(snapshot.data, leaseId);
      if (!existing) throw new Error(`lease not found: ${leaseId}`);
      const effectiveOwnerToken = leaseOwnerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);
      if (Number(existing.expiresAtMs) <= nowMs) {
        throw Object.assign(new Error(`lease expired: ${leaseId}`), { code: "ESTALE" });
      }
      const renewed: LeaseRecord = {
        ...existing,
        heartbeatAt: new Date(nowMs).toISOString(),
        expiresAtMs: nowMs + ttlMs,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      const committed = await redis.compareAndSwapStateRecord(field, snapshot.revision, renewed);
      if (committed.committed) {
        rememberOwnerToken(cpbRoot, leaseId, String(renewed.ownerToken));
        return renewed;
      }
    }
    throw Object.assign(new Error(`lease changed too frequently: ${leaseId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }
  const file = leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
  return await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing === null) {
        throw new Error(`lease not found: ${leaseId}`);
      }

      const effectiveOwnerToken = leaseOwnerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      const renewed: LeaseRecord = {
        ...existing,
        heartbeatAt: now.toISOString(),
        expiresAt: expiresAtFor(now, ttlMs),
      };

      await atomicWriteJson(file, renewed);
      rememberOwnerToken(cpbRoot, leaseId, renewed.ownerToken);
      return renewed;
    },
    { lockTtlMs }
  );
}

export async function releaseLease(
  cpbRoot: string,
  leaseId: string,
  { ownerToken, lockTtlMs, dataRoot, includeLegacyFallback = false }: ReleaseLeaseOptions = {}
) {
  const redis = await redisLeaseBackend();
  if (redis) {
    await assertNoLocalLeaseState(cpbRoot, { dataRoot, includeLegacyFallback });
    const field = redisLeaseField(leaseId);
    for (let retry = 0; retry < 64; retry += 1) {
      const snapshot = await redis.readStateRecord(field);
      const existing = parseRedisLease(snapshot.data, leaseId);
      if (!existing) return;
      const effectiveOwnerToken = leaseOwnerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);
      const committed = await redis.compareAndSwapStateRecord(field, snapshot.revision, null);
      if (committed.committed) {
        forgetOwnerToken(cpbRoot, leaseId, String(existing.ownerToken));
        return;
      }
    }
    throw Object.assign(new Error(`lease changed too frequently: ${leaseId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }
  const file = leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });

  const releaseLock = await acquireLeaseFileLock(file, { lockTtlMs });
  try {
    const existing = await readLeaseFile(file);
    if (existing === null) {
      return;
    }

    const effectiveOwnerToken = leaseOwnerTokenFor(cpbRoot, leaseId, ownerToken);
    assertLeaseOwner(existing, effectiveOwnerToken);

    await rm(file);
    forgetOwnerToken(cpbRoot, leaseId, existing.ownerToken);
  } finally {
    await releaseLock();
  }
}

// ── concurrency-limits (from concurrency-limits.ts) ────────────────────────


export const DEFAULT_MAX_ACTIVE_PER_PROJECT = Number(process.env.CPB_HUB_MAX_ACTIVE_PER_PROJECT || 2);
export const DEFAULT_ACP_PROVIDER_MAX = Number(process.env.CPB_ACP_POOL_PROVIDER_MAX || 3);

export function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function maxActiveForProject(project: LooseRecord | null | undefined, fallback = DEFAULT_MAX_ACTIVE_PER_PROJECT): number {
  const projectRecord = recordValue(project);
  const concurrency = recordValue(projectRecord.concurrency);
  const metadata = recordValue(projectRecord.metadata);
  return positiveInt(
    concurrency.maxActivePerProject
      ?? concurrency.maxActive
      ?? metadata.maxActivePerProject
      ?? metadata.maxActive,
    fallback,
  );
}

function hasConfig(value: LooseRecord | null | undefined) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function mergeProjectConfig(registryProject: LooseRecord | null | undefined, projectJson: LooseRecord | null | undefined) {
  if (!hasConfig(registryProject) && !hasConfig(projectJson)) return null;
  const registry = recordValue(registryProject);
  const project = recordValue(projectJson);
  return {
    ...registry,
    ...project,
    metadata: {
      ...recordValue(registry.metadata),
      ...recordValue(project.metadata),
    },
    concurrency: {
      ...recordValue(registry.concurrency),
      ...recordValue(project.concurrency),
    },
  };
}

async function defaultGetProject(hubRoot: string, projectId: string): Promise<LooseRecord | null> {
  const { getProject } = await import("./hub/hub-registry.js");
  const project = await getProject(hubRoot, projectId);
  return project ? recordValue(project) : null;
}

export async function readProjectConcurrencyConfig(hubRoot: string, projectId: string, getProjectFn: GetProjectFn | null = null) {
  const { readProjectJsonFromRoots } = await import("./agent/agent-config.js");
  if (!projectId) return null;
  const registryProject = await (getProjectFn || defaultGetProject)(hubRoot, projectId).catch(() => null);
  const projectJson = await readProjectJsonFromRoots([hubRoot], projectId).catch(() => ({}));
  return mergeProjectConfig(registryProject, projectJson);
}

export async function resolveProjectConcurrencyLimits(hubRoot: string, projectIds: string[], {
  maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
  getProjectFn = null,
}: ResolveProjectConcurrencyOptions = {}) {
  const fallback = positiveInt(maxActivePerProject, DEFAULT_MAX_ACTIVE_PER_PROJECT);
  const limits = new Map();
  for (const projectId of [...new Set((projectIds || []).filter(Boolean))]) {
    const project = await readProjectConcurrencyConfig(hubRoot, projectId, getProjectFn);
    limits.set(projectId, maxActiveForProject(project, fallback));
  }
  return limits;
}

export async function resolveHubConcurrencyLimits(hubRoot: string, fallback: LooseRecord = {}) {
  const { readHubConfig } = await import("./agent/agent-config.js");
  const config = recordValue(await readHubConfig(hubRoot).catch(() => ({})));
  const concurrency = recordValue(config.concurrency);
  const acpPool = recordValue(config.acpPool);
  const fallbackLimits = fallback;
  return {
    maxActivePerProject: positiveInt(
      concurrency.maxActivePerProject ?? fallbackLimits.maxActivePerProject,
      DEFAULT_MAX_ACTIVE_PER_PROJECT,
    ),
    acpProviderMax: positiveInt(
      acpPool.providerMax ?? fallbackLimits.acpProviderMax,
      DEFAULT_ACP_PROVIDER_MAX,
    ),
  };
}

export function hubConcurrencyEnv(limits: LooseRecord = {}): Record<string, string> {
  const limitValues = limits;
  const env: Record<string, string> = {};
  if (limitValues.maxActivePerProject) env.CPB_HUB_MAX_ACTIVE_PER_PROJECT = String(limitValues.maxActivePerProject);
  if (limitValues.acpProviderMax) env.CPB_ACP_POOL_PROVIDER_MAX = String(limitValues.acpProviderMax);
  return env;
}

// ── process-registry (from process-registry.ts) ────────────────────────────

export const PROCESS_REGISTRY_FORMAT_VERSION = 1;

function validateId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

function processDir(cpbRoot: string, { dataRoot, includeLegacyFallback = false }: RuntimeStorageOptions = {}) {
  if (dataRoot) return path.join(path.resolve(dataRoot), "processes");
  if (includeLegacyFallback === true) return path.join(path.resolve(cpbRoot), "cpb-task", "processes");
  throw new Error("project runtime root required for process registry");
}

function processFile(cpbRoot: string, jobId: string, options: RuntimeStorageOptions = {}) {
  validateId(jobId, "jobId");
  return path.join(processDir(cpbRoot, options), `${jobId}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

async function readJsonFile(file: string): Promise<ProcessEntry | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ProcessEntry;
  } catch {
    return null;
  }
}

async function writeJsonFile(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  const { rename: renameFn } = await import("node:fs/promises");
  await renameFn(tmp, file);
}

export async function registerProcess(cpbRoot: string, { jobId, project, phase, runnerPid, treeId, leaseId, command, startedAt, cwd, executorRoot, dataRoot, includeLegacyFallback = false }: RegisterProcessOptions = {}) {
  validateId(jobId, "jobId");
  const file = processFile(cpbRoot, jobId, { dataRoot, includeLegacyFallback });
  const entry: ProcessEntry = {
    jobId,
    project: project || null,
    phase: phase || null,
    runnerPid: runnerPid || process.pid,
    treeId: treeId || null,
    childPids: [],
    leaseId: leaseId || null,
    startedAt: startedAt || nowIso(),
    lastHeartbeat: nowIso(),
    status: "running",
    exitCode: null,
    command: command || null,
    cwd: cwd || null,
    executorRoot: executorRoot || null,
  };
  await writeJsonFile(file, entry);
  return entry;
}

export async function updateHeartbeat(cpbRoot: string, jobId: string, options: RuntimeStorageOptions = {}) {
  const file = processFile(cpbRoot, jobId, options);
  const entry = await readJsonFile(file);
  if (!entry) return null;
  entry.lastHeartbeat = nowIso();
  await writeJsonFile(file, entry);
  return entry;
}

export async function markExited(cpbRoot: string, jobId: string, { exitCode, status = "exited", dataRoot, includeLegacyFallback = false }: MarkExitedOptions = {}) {
  const file = processFile(cpbRoot, jobId, { dataRoot, includeLegacyFallback });
  const entry = await readJsonFile(file);
  if (!entry) return null;
  entry.status = status;
  entry.exitCode = exitCode ?? null;
  await writeJsonFile(file, entry);
  return entry;
}

export async function addChildPid(cpbRoot: string, jobId: string, childPid: number, options: RuntimeStorageOptions = {}) {
  const file = processFile(cpbRoot, jobId, options);
  const entry = await readJsonFile(file);
  if (!entry) return null;
  if (!entry.childPids.includes(childPid)) {
    entry.childPids.push(childPid);
  }
  await writeJsonFile(file, entry);
  return entry;
}

export async function getProcess(cpbRoot: string, jobId: string, options: RuntimeStorageOptions = {}) {
  return readJsonFile(processFile(cpbRoot, jobId, options));
}

export async function listProcesses(cpbRoot: string, options: RuntimeStorageOptions = {}): Promise<ProcessEntry[]> {
  const dir = processDir(cpbRoot, options);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const results: ProcessEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const entry = await readJsonFile(path.join(dir, name));
    if (entry) {
      entry.liveness = classifyLiveness(entry);
      entry.ageMs = computeAge(entry);
      results.push(entry);
    }
  }
  return results;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true;
    return false;
  }
}

export function computeAge(entry: ProcessEntry) {
  if (!entry?.startedAt) return null;
  const started = new Date(entry.startedAt).getTime();
  if (Number.isNaN(started)) return null;
  return Date.now() - started;
}

export function classifyLiveness(entry: ProcessEntry | null | undefined, { staleThresholdMs = 180_000 }: { staleThresholdMs?: number } = {}) {
  if (!entry) return "unknown";
  if (entry.status === "exited" || entry.status === "stopped") return entry.status;

  const { runnerPid } = entry;
  if (!isProcessAlive(runnerPid)) return "orphan";

  const lastHb = new Date(entry.lastHeartbeat).getTime();
  if (Number.isNaN(lastHb)) return "unknown";
  const age = Date.now() - lastHb;
  if (age > staleThresholdMs) return "stale";

  return "alive";
}

export async function stopProcess(cpbRoot: string, jobId: string) {
  const entry = await getProcess(cpbRoot, jobId);
  if (!entry) return { stopped: false, reason: "not found" };

  const { project } = entry;
  const ts = nowIso();

  async function audit(type: string, extra: LooseRecord = {}) {
    if (!project) return;
    try {
      const { appendEvent } = await import("./event/event-store.js");
      await appendEvent(cpbRoot, project, jobId, { type, jobId, project, runnerPid: entry.runnerPid, ts, ...extra });
    } catch {}
  }

  if (entry.status === "exited" || entry.status === "stopped") {
    await audit("process_stop_skipped", { reason: `already ${entry.status}` });
    return { stopped: false, reason: `already ${entry.status}` };
  }

  if (!isProcessAlive(entry.runnerPid)) {
    await markExited(cpbRoot, jobId, { status: "orphan" });
    await audit("process_marked_orphan");
    return { stopped: false, reason: "process already dead (marked orphan)" };
  }

  try {
    const procStat = await stat(`/proc/${entry.runnerPid}`);
    const registeredAt = new Date(entry.startedAt).getTime();
    if (procStat.birthtimeMs > registeredAt + 5000) {
      await audit("process_stop_skipped", { reason: "PID recycled: process identity mismatch" });
      return { stopped: false, reason: "PID recycled: process identity mismatch" };
    }
  } catch {
    // /proc not available (macOS), rely on PID being alive
  }

  const pids = [entry.runnerPid, ...entry.childPids];
  await audit("process_stop_requested", { signaledPids: pids });

  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }

  await new Promise((r) => setTimeout(r, 2000));

  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }

  await markExited(cpbRoot, jobId, { exitCode: -15, status: "stopped" });
  await audit("process_stopped", { signaledPids: pids });
  return { stopped: true, jobId, signaledPids: pids };
}

export async function cleanProcesses(cpbRoot: string, { dryRun = false }: { dryRun?: boolean } = {}) {
  const entries = await listProcesses(cpbRoot);
  const eligible: ProcessEntry[] = [];

  for (const entry of entries) {
    const liveness = classifyLiveness(entry);
    if (liveness === "exited" || liveness === "orphan") {
      eligible.push(entry);
    }
  }

  if (dryRun) {
    return { dryRun: true, removed: [], eligible };
  }

  const removed: string[] = [];
  for (const entry of eligible) {
    const file = processFile(cpbRoot, entry.jobId);
    await rm(file, { force: true });
    removed.push(entry.jobId);
  }
  return { dryRun: false, removed, eligible };
}

export async function removeProcess(cpbRoot: string, jobId: string, { dryRun = false, dataRoot }: ProcessRegistryOptions = {}) {
  validateId(jobId, "jobId");
  const file = processFile(cpbRoot, jobId, { dataRoot });
  if (dryRun) {
    const entry = await readJsonFile(file);
    return { removed: false, wouldRemove: !!entry, jobId };
  }
  await rm(file, { force: true });
  return { removed: true, jobId };
}

export async function inspectProcess(cpbRoot: string, jobId: string) {
  const entry = await getProcess(cpbRoot, jobId);
  const liveness = entry ? classifyLiveness(entry) : null;

  let leaseState = null;
  if (entry?.leaseId) {
    try {
      const lease = await readLease(cpbRoot, entry.leaseId);
      if (lease) {
        leaseState = {
          leaseId: entry.leaseId,
          stale: isLeaseStale(lease),
          expiresAt: lease.expiresAt,
          phase: lease.phase,
        };
      }
    } catch {}
  }

  let project = entry?.project || null;
  let job = null;

  try {
    const { getJob, listJobs } = await import("./job/job-store.js");
    if (project) {
      job = await getJob(cpbRoot, project, jobId);
      if (job && !job.jobId) job = null;
    }
    if (!job) {
      const allJobs = await listJobs(cpbRoot);
      job = allJobs.find((j: JobLike) => j.jobId === jobId) || null;
      if (job && !project) project = job.project;
    }
  } catch {}

  let recentEvents = [];
  if (project) {
    try {
      const { readEvents } = await import("./event/event-store.js");
      const events = await readEvents(cpbRoot, project, jobId);
      recentEvents = events.slice(-10);
    } catch {}
  }

  let lineage = job?.lineage || null;

  let ancestors = [];
  let children = [];
  try {
    const { listJobs: listAllJobs, getJob: getJobForLineage } = await import("./job/job-store.js");
    const allJobs = await listAllJobs(cpbRoot);
    children = allJobs.filter((j: JobLike) => j.lineage?.parentJobId === jobId);

    if (lineage?.parentJobId) {
      const ancestorMap = new Map(allJobs.map((j: JobLike) => [j.jobId, j]));
      let curId = lineage.parentJobId;
      let depth = 0;
      while (curId && depth < 5) {
        const ancestor = ancestorMap.get(curId);
        if (!ancestor) break;
        ancestors.push(ancestor);
        curId = ancestor.lineage?.parentJobId || null;
        depth++;
      }
    }
  } catch {}

  if (!entry && !job) return null;

  let policyState = null;
  if (job) {
    try {
      const { getPhasePolicy } = await import("./permission-matrix.js");
      const role = entry?.phase ? { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", remediate: "remediator" }[entry.phase] : null;
      if (role) {
        const sp = job.worktree || process.env.CPB_PROJECT_PATH_OVERRIDE || null;
        let profileConfig = null;
        try {
          const { loadProfile } = await import("./prompt/prompt-resources.js");
          const profile = await loadProfile(cpbRoot, role);
          profileConfig = profile.permissions || null;
        } catch {}
        policyState = getPhasePolicy(role, cpbRoot, project, { sourcePath: sp, profileConfig });
      }
    } catch {}
  }

  return {
    process: entry,
    job,
    liveness,
    lease: leaseState,
    recentEvents,
    lineage,
    ancestors,
    children,
    policy: policyState,
  };
}

// ── index-freshness (from index-freshness.ts) ──────────────────────────────

export const INDEX_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

const CPB_RUNTIME_PREFIXES = ["cpb-task/", ".cpb/"];

function indexDir(rtRoot: string) {
  return path.join(rtRoot, "index");
}
function manifestFile(rtRoot: string) {
  return path.join(indexDir(rtRoot), "manifest.json");
}
function snapshotsDir(rtRoot: string) {
  return path.join(indexDir(rtRoot), "snapshots");
}
function snapshotFile(rtRoot: string, id: string) {
  return path.join(snapshotsDir(rtRoot), `${id}.json`);
}

function hashString(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function extractPath(line: string) {
  if (line.length >= 4 && line[2] === " ") return line.slice(3);
  return line;
}

function filterCpbPaths(lines: string[]) {
  return lines.filter((l: string) => {
    const p = extractPath(l.trim());
    return p && !CPB_RUNTIME_PREFIXES.some((pre) => p.startsWith(pre));
  });
}

async function git(args: string[], cwd: string, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function worktreeStatusHash(sourcePath: string) {
  const raw = await git(["status", "--porcelain=v1", "--untracked-files=all"], sourcePath);
  return hashString(filterCpbPaths(raw.split("\n")).join("\n"));
}

async function fileInventoryHash(sourcePath: string) {
  const raw = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], sourcePath);
  return hashString(filterCpbPaths(raw.split("\0")).join("\n"));
}

async function gitHead(sourcePath: string) {
  return (await git(["rev-parse", "HEAD"], sourcePath)).trim();
}

async function gitBranch(sourcePath: string) {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], sourcePath)).trim();
}

async function importantConfigHash(project: IndexProject) {
  const { realpath: realpathFn } = await import("node:fs/promises");
  const resolvedSourcePath = await realpathFn(project.sourcePath || "").catch(() => project.sourcePath);
  const stable = {
    id: project.id,
    name: project.name,
    sourcePath: resolvedSourcePath,
    projectRoot: project.projectRoot,
    projectRuntimeRoot: project.projectRuntimeRoot,
    metadata: project.metadata || {},
  };
  return hashString(JSON.stringify(stable));
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

function generateSnapshotId() {
  return `idx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function checkIndexFreshness(project: IndexProject, opts: { ttlMs?: number; now?: number } = {}) {
  const { ttlMs = DEFAULT_INDEX_TTL_MS, now = Date.now() } = opts;
  const rtRoot = project.projectRuntimeRoot;
  const sourcePath = project.sourcePath;

  const result: IndexFreshnessResult = {
    worktreeDirty: false,
    indexDirty: false,
    indexStale: false,
    dirtyReasons: [],
    manifest: null,
  };

  if (!sourcePath || !rtRoot) {
    result.indexDirty = true;
    result.dirtyReasons.push("missing_source_or_runtime_root");
    return result;
  }

  let existing: IndexManifest;
  try {
    existing = JSON.parse(await readFile(manifestFile(rtRoot), "utf8"));
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      result.indexDirty = true;
      result.dirtyReasons.push("missing_manifest");
      return result;
    }
    throw err;
  }
  result.manifest = existing;

  if ((existing.schemaVersion ?? 0) !== INDEX_MANIFEST_SCHEMA_VERSION) {
    result.indexDirty = true;
    result.dirtyReasons.push("schema_change");
  }

  const { realpath: realpathFn } = await import("node:fs/promises");
  if (existing.sourcePath !== await realpathFn(sourcePath).catch(() => sourcePath)) {
    result.indexDirty = true;
    result.dirtyReasons.push("source_path_mismatch");
    return result;
  }

  const [curHead, curBranch, curWt, curFi] = await Promise.all([
    gitHead(sourcePath),
    gitBranch(sourcePath),
    worktreeStatusHash(sourcePath),
    fileInventoryHash(sourcePath),
  ]);
  const curCfg = await importantConfigHash(project);

  if (curHead !== existing.gitHead) {
    result.indexDirty = true;
    result.dirtyReasons.push("head_change");
  }
  if (curWt !== existing.worktreeStatusHash) {
    result.worktreeDirty = true;
    result.indexDirty = true;
    result.dirtyReasons.push("worktree_status_change");
  }
  if (curFi !== existing.fileInventoryHash) {
    result.indexDirty = true;
    result.dirtyReasons.push("file_inventory_change");
  }
  if (curCfg !== existing.importantConfigHash) {
    result.indexDirty = true;
    result.dirtyReasons.push("project_config_change");
  }

  if (!result.indexDirty) {
    const indexedAt = existing.indexedAt ? new Date(existing.indexedAt).getTime() : 0;
    if (Number.isFinite(indexedAt) && now - indexedAt > ttlMs) {
      result.indexStale = true;
    }
  }

  return result;
}

export async function refreshIndexManifest(project: IndexProject, opts: { now?: string | number } = {}) {
  const rtRoot = project.projectRuntimeRoot;
  const sourcePath = project.sourcePath;
  const { realpath: realpathFn } = await import("node:fs/promises");
  const resolvedSourcePath = await realpathFn(sourcePath).catch(() => sourcePath);
  const { now = new Date().toISOString() } = opts;

  const [head, branch, wtHash, fiHash] = await Promise.all([
    gitHead(sourcePath),
    gitBranch(sourcePath),
    worktreeStatusHash(sourcePath),
    fileInventoryHash(sourcePath),
  ]);
  const cfgHash = await importantConfigHash(project);

  const snapshotId = generateSnapshotId();
  const manifest = {
    schemaVersion: INDEX_MANIFEST_SCHEMA_VERSION,
    projectId: project.id,
    sourcePath: resolvedSourcePath,
    branch,
    gitHead: head,
    worktreeStatusHash: wtHash,
    fileInventoryHash: fiHash,
    importantConfigHash: cfgHash,
    indexedAt: now,
    indexSnapshotId: snapshotId,
  };

  await writeAtomic(manifestFile(rtRoot), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(snapshotsDir(rtRoot), { recursive: true });
  await writeAtomic(snapshotFile(rtRoot, snapshotId), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    available: true,
    indexDirty: false,
    indexStale: false,
    worktreeDirty: false,
    dirtyReasons: [],
    indexSnapshotId: snapshotId,
    sourceFingerprint: { gitHead: head, branch, worktreeStatusHash: wtHash, fileInventoryHash: fiHash, importantConfigHash: cfgHash },
    manifest,
  };
}

export async function ensureIndexFresh(project: IndexProject, opts: { ttlMs?: number; now?: number | string } = {}) {
  if (project.sourcePath) {
    const isGit = await git(["rev-parse", "--git-dir"], project.sourcePath).then(() => true).catch(() => false);
    if (!isGit) {
      try { await (await import("node:fs/promises")).realpath(project.sourcePath); } catch {
        return { available: false, indexDirty: true, indexStale: false, worktreeDirty: false, dirtyReasons: ["missing_source_or_runtime_root"], indexSnapshotId: null, sourceFingerprint: null, error: "source path not found" };
      }
      return { available: true, indexDirty: false, indexStale: false, worktreeDirty: false, dirtyReasons: [], indexSnapshotId: null, sourceFingerprint: null };
    }
  }
  try {
    const check = await checkIndexFreshness(project, {
      ttlMs: opts.ttlMs,
      ...(typeof opts.now === "number" ? { now: opts.now } : {}),
    });

    if (!check.indexDirty && !check.indexStale && check.manifest?.indexSnapshotId) {
      const m = check.manifest;
      return {
        available: true,
        indexDirty: false,
        indexStale: false,
        worktreeDirty: check.worktreeDirty,
        dirtyReasons: [],
        indexSnapshotId: m.indexSnapshotId,
        sourceFingerprint: {
          gitHead: m.gitHead,
          branch: m.branch,
          worktreeStatusHash: m.worktreeStatusHash,
          fileInventoryHash: m.fileInventoryHash,
          importantConfigHash: m.importantConfigHash,
        },
        manifest: m,
      };
    }

    return await refreshIndexManifest(project, opts);
  } catch (err) {
    const message = errorMessage(err);
    return {
      available: false,
      indexDirty: true,
      indexStale: false,
      worktreeDirty: false,
      dirtyReasons: [`refresh_failed: ${message}`],
      indexSnapshotId: null,
      sourceFingerprint: null,
      error: message,
    };
  }
}

export function parseEnvSnapshot(raw: string) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.indexSnapshotId === "string" &&
      parsed.indexSnapshotId
    ) {
      return {
        indexSnapshot: {
          indexSnapshotId: parsed.indexSnapshotId,
          sourceFingerprint: parsed.sourceFingerprint ?? null,
        },
        indexFreshness: parsed.indexFreshness ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function snapshotForJob(result: Partial<IndexFreshnessResult> | null | undefined) {
  if (!result || !result.available) {
    return {
      indexSnapshotId: null,
      sourceFingerprint: null,
      indexFreshness: {
        available: false,
        indexDirty: result?.indexDirty ?? true,
        indexStale: result?.indexStale ?? false,
        worktreeDirty: result?.worktreeDirty ?? false,
        dirtyReasons: result?.dirtyReasons ?? ["codegraph_unavailable"],
      },
    };
  }
  return {
    indexSnapshotId: result.indexSnapshotId,
    sourceFingerprint: result.sourceFingerprint,
    indexFreshness: {
      available: true,
      indexDirty: false,
      indexStale: false,
      worktreeDirty: result.worktreeDirty ?? false,
      dirtyReasons: [],
    },
  };
}

// ── Re-exports from merged modules ──
export { CodeGraphUnavailableError, checkCodeGraphReady } from "./readiness-checks.js";
export { classifyDeleteRisk, formatDeleteBlockedMessage, logDeleteBlock } from "./permission-matrix.js";
