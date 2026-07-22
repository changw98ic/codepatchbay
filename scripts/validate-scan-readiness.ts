#!/usr/bin/env node
// validate-scan-readiness.js — Bounded operational validation for multi-project scan
// under simulated 429/backoff pressure.
//
// Usage:
//   node scripts/validate-scan-readiness.js                # dry-run with temp dirs
//   node scripts/validate-scan-readiness.js --live         # validate against real hub root
//   node scripts/validate-scan-readiness.js --hub-root DIR # validate specific hub root
//   node scripts/validate-scan-readiness.js --json         # machine-readable output
//
// Checks:
//   1. Queue integrity: loads/parses, valid state machine
//   2. Queue status surfaces: correct pending/in_progress/completed counts
//   3. Rate-limit backoff: 429 → durable backoff → pool respects it
//   4. Concurrency bounds: pool never exceeds configured limits
//   5. Multi-project scan under 429: backoff propagates across projects
//   6. Process growth bound: pool tracks active requests, no leak after release

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordValue, type LooseRecord } from "../shared/types.js";
import {
  captureProcessIdentity,
  killTree,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../core/runtime/process-tree.js";
import {
  createTemporaryWorkspace,
  type TemporaryWorkspace,
} from "../core/runtime/temporary-workspace.js";

import { AcpPool } from "../server/services/acp/acp-pool.js";
import { enqueue, loadQueue, queueStatus, updateEntry } from "../server/services/hub/hub-queue.js";
import { resolveHubRoot } from "../server/services/hub/hub-registry.js";
import { assertProviderAvailable, ProviderQuotaError } from "../server/services/provider-quota.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type TeardownOptions = {
  identity?: ProcessIdentity | null;
  graceMs?: number;
  closeTimeoutMs?: number;
  processTreeSystem?: ProcessTreeSystem;
};

function processIdentityError(message: string, code = "PROCESS_IDENTITY_UNAVAILABLE") {
  return Object.assign(new Error(message), { code });
}

function isExactProcessIdentity(identity: ProcessIdentity | null | undefined): identity is ProcessIdentity {
  const capturedAt = identity?.capturedAt || "";
  const capturedAtMs = Date.parse(capturedAt);
  return Boolean(
    identity
      && identity.birthIdPrecision === "exact"
      && Number.isSafeInteger(identity.pid)
      && identity.pid > 0
      && typeof identity.birthId === "string"
      && identity.birthId.length > 0
      && identity.incarnation === `${identity.pid}:${identity.birthId}`
      && Number.isFinite(capturedAtMs)
      && new Date(capturedAtMs).toISOString() === capturedAt
      && (identity.processGroupId === undefined
        || (Number.isSafeInteger(identity.processGroupId) && identity.processGroupId > 0)),
  );
}

export function captureScriptChildIdentity(
  child: Pick<ChildProcess, "pid">,
  system?: ProcessTreeSystem,
): ProcessIdentity | null {
  if (!child.pid) return null;
  try {
    return captureProcessIdentity(child.pid, { strict: true, system });
  } catch {
    return null;
  }
}

function closeChildStreams(child: ChildProcess) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function appendCleanupFailure(primary: Error, cleanupFailure: unknown) {
  return new AggregateError(
    [primary, cleanupFailure],
    `${primary.message}; cleanup failed: ${describeError(cleanupFailure)}`,
  );
}

function observeClose(child: ChildProcess, allowAlreadyExited = true) {
  return new Promise<void>((resolve) => {
    if (allowAlreadyExited && (child.exitCode !== null || child.signalCode !== null)) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

async function waitForObservedClose(observed: Promise<void>, timeoutMs = 10_000) {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      observed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("process did not close within timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function teardownScriptChildProcess(child: ChildProcess, options: TeardownOptions = {}) {
  const running = Boolean(child.pid && child.exitCode === null && child.signalCode === null);
  const closeObserved = observeClose(child, !running);
  let teardownError: unknown = null;
  if (running && child.pid) {
    if (!isExactProcessIdentity(options.identity)) {
      teardownError = processIdentityError("script child exact spawn identity unavailable; refusing to signal by bare pid");
      closeChildStreams(child);
    } else {
      try {
        await killTree(child.pid, options.graceMs ?? 2_000, {
          requireDescendantScan: true,
          expectedRootIdentity: options.identity,
          system: options.processTreeSystem,
          forceVerifyMs: options.closeTimeoutMs ?? 10_000,
        });
      } catch (error) {
        teardownError = error;
      }
    }
  }
  let closeError: unknown = null;
  try {
    await waitForObservedClose(closeObserved, options.closeTimeoutMs ?? 10_000);
  } catch (error) {
    closeError = error;
  }
  if (teardownError && closeError) {
    throw new AggregateError([teardownError, closeError], "script child teardown and close wait both failed", {
      cause: teardownError,
    });
  }
  if (teardownError) throw teardownError;
  if (closeError) throw closeError;
}

type CliOptions = {
  live: boolean;
  hubRoot: string | null;
  json: boolean;
  verbose: boolean;
  help?: boolean;
};

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { live: false, hubRoot: null, json: false, verbose: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "--hub-root") {
      const v = args[++i];
      if (!v || v.startsWith("--")) throw new Error("missing value for --hub-root");
      opts.hubRoot = v;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function makeTempHub(): Promise<TemporaryWorkspace> {
  return createTemporaryWorkspace({ prefix: "cpb-val-" });
}

async function withQuotaDelegate(hubRoot: string, fn: () => Promise<unknown>) {
  const delegateScript = path.join(__dirname, "..", "server", "services", "quota-delegate.js");
  const child = spawn(process.execPath, [delegateScript, "--hub-root", hubRoot], {
    env: { ...process.env, CPB_DELEGATE_POLL_MS: "10" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identity = captureScriptChildIdentity(child);

  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const primary = new Error(`quota delegate did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      teardownScriptChildProcess(child, { identity })
        .then(() => reject(primary), (cleanupFailure) => reject(appendCleanupFailure(primary, cleanupFailure)));
    }, 3_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("quota-delegate: started")) {
        finish(resolve);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code) => {
      finish(() => reject(new Error(`quota delegate exited before start: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`)));
    });
  });

  let primaryFailure: unknown;
  try {
    return await fn();
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await teardownScriptChildProcess(child, { identity });
    } catch (cleanupFailure) {
      if (primaryFailure instanceof Error) throw appendCleanupFailure(primaryFailure, cleanupFailure);
      throw cleanupFailure;
    }
  }
}

async function seedQueue(hubRoot: string, entries: LooseRecord[]) {
  for (const e of entries) {
    await enqueue(hubRoot, {
      projectId: stringValue(e.projectId, "test-project"),
      sourcePath: stringValue(e.sourcePath, "/tmp/fake"),
      description: stringValue(e.description, `issue-${Math.random().toString(36).slice(2, 6)}`),
      priority: stringValue(e.priority, "P2"),
      type: stringValue(e.type, "candidate"),
    });
  }
}

function makeFakeProjects(n: number) {
  const projects = [];
  for (let i = 0; i < n; i++) {
    projects.push({
      projectId: `proj-${i}`,
      sourcePath: `/tmp/fake-${i}`,
      description: `scan-issue-${i}`,
      priority: i === 0 ? "P0" : "P2",
    });
  }
  return projects;
}

// ── Checks (each gets an isolated hubRoot) ───────────────────────────────────

export async function checkQueueIntegrity(hubRoot: string) {
  const projects = makeFakeProjects(5);
  await seedQueue(hubRoot, projects);
  const queue = await loadQueue(hubRoot);
  if (!queue || !Array.isArray(queue.entries)) return { pass: false, detail: "queue did not parse" };
  if (queue.entries.length < 5) return { pass: false, detail: `expected >=5 entries, got ${queue.entries.length}` };
  for (const e of queue.entries) {
    if (e.status !== "pending") return { pass: false, detail: `entry ${e.id} not pending: ${e.status}` };
    if (!e.projectId) return { pass: false, detail: `entry ${e.id} missing projectId` };
  }
  return { pass: true, detail: `${queue.entries.length} entries, all pending with valid state` };
}

export async function checkQueueStatusSurfaces(hubRoot: string) {
  await seedQueue(hubRoot, [
    { projectId: "a", description: "a-1" },
    { projectId: "a", description: "a-2" },
    { projectId: "b", description: "b-1" },
  ]);
  const status = await queueStatus(hubRoot);
  if (status.pending !== 3) return { pass: false, detail: `expected 3 pending, got ${status.pending}` };

  const queue = await loadQueue(hubRoot);
  const target = queue.entries[0];
  await updateEntry(hubRoot, target.id, { status: "in_progress" });
  const after = await queueStatus(hubRoot);
  if (after.pending !== 2 || after.inProgress !== 1) {
    return { pass: false, detail: `after transition: pending=${after.pending} in_progress=${after.inProgress}` };
  }
  return { pass: true, detail: `pending→in_progress correct: ${JSON.stringify(after)}` };
}

export async function checkRateLimitBackoff(hubRoot: string) {
  return withQuotaDelegate(hubRoot, async () => {
    const pool = new AcpPool({
      hubRoot,
      limits: { codex: 1 },
      backoffMs: 5_000,
      runner: async () => { throw new Error("429 rate limit: retry after 5 seconds"); },
    });
    const providerKey = pool.providerKey("codex");

    let firstQuotaError = null;
    try {
      await pool.execute("codex", "trigger-429");
      return { pass: false, detail: "429 runner should have thrown" };
    } catch (err) {
      if (!(err instanceof ProviderQuotaError)) {
        return { pass: false, detail: `expected ProviderQuotaError, got ${err.name}: ${err.message}` };
      }
      firstQuotaError = err;
    }

    try {
      await assertProviderAvailable(hubRoot, { providerKey, agent: "codex" });
      return { pass: false, detail: "provider quota gate should reject during backoff" };
    } catch (err) {
      if (!(err instanceof ProviderQuotaError)) {
        return { pass: false, detail: `quota gate rejection not ProviderQuotaError: ${err.name}` };
      }
      const quotaError = err as ProviderQuotaError & { nextEligibleAt?: number };
      if (!quotaError.nextEligibleAt || quotaError.nextEligibleAt <= Date.now()) {
        return { pass: false, detail: `nextEligibleAt not in future: ${quotaError.nextEligibleAt}` };
      }
      return {
        pass: true,
        detail: `429 → delegate quota write, gate blocks until ${new Date(quotaError.nextEligibleAt).toISOString()} (source=${firstQuotaError.source})`,
      };
    }
  });
}

export async function checkConcurrencyBounds(hubRoot: string) {
  let maxActive = 0;
  let currentActive = 0;
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 2 },
    providerConnectionLimit: 2,
    runner: async () => {
      currentActive++;
      maxActive = Math.max(maxActive, currentActive);
      await new Promise((r) => setTimeout(r, 30));
      currentActive--;
      return "ok";
    },
  });

  const promises = [];
  for (let i = 0; i < 6; i++) {
    promises.push(pool.execute("codex", `concurrent-${i}`));
  }
  const results = await Promise.all(promises);

  if (results.some((r) => r.output !== "ok")) return { pass: false, detail: "some executions failed" };
  if (maxActive > 2) return { pass: false, detail: `maxActive=${maxActive} exceeded limit of 2` };

  const st = recordValue(recordValue(pool.status().pools).codex);
  if (st.active !== 0) return { pass: false, detail: `active=${st.active} after all resolved (leak)` };

  return { pass: true, detail: `6 tasks, limit 2, maxActive=${maxActive}, active now=${st.active}` };
}

export async function checkMultiProjectScanUnder429(hubRoot: string) {
  return withQuotaDelegate(hubRoot, async () => {
    let callCount = 0;
    const rateLimitedProjects = new Set();

    const pool = new AcpPool({
      hubRoot,
      limits: { codex: 1 },
      backoffMs: 30_000,
      runner: async ({ prompt }) => {
        callCount++;
        if (prompt.includes("proj-1")) {
          throw new Error("429 rate limit exceeded for proj-1");
        }
        return "[ISSUE] P2 normal finding";
      },
    });
    const providerKey = pool.providerKey("codex");

    const projects: (LooseRecord & { id: string; sourcePath: string; name: string; enabled: boolean })[] = [
      { id: "proj-0", sourcePath: "/tmp/fake-0", name: "proj-0", enabled: true },
      { id: "proj-1", sourcePath: "/tmp/fake-1", name: "proj-1", enabled: true },
      { id: "proj-2", sourcePath: "/tmp/fake-2", name: "proj-2", enabled: true },
    ];

    for (const project of projects) {
      try {
        await assertProviderAvailable(hubRoot, { providerKey, agent: "codex" });
      } catch (err) {
        if (!(err instanceof ProviderQuotaError)) throw err;
        project.rateLimitedUntil = (err as ProviderQuotaError & { nextEligibleAt?: number }).nextEligibleAt;
        rateLimitedProjects.add(project.id);
        continue;
      }

      try {
        await pool.execute("codex", `scan-${project.id}`, project.sourcePath, 5_000);
      } catch (err) {
        if (!(err instanceof ProviderQuotaError)) {
          return { pass: false, detail: `unexpected scan error for ${project.id}: ${err.name}: ${err.message}` };
        }
        project.rateLimitedUntil = (err as ProviderQuotaError & { nextEligibleAt?: number }).nextEligibleAt;
        rateLimitedProjects.add(project.id);
      }
    }

    const blocked = projects.filter((p) => p.rateLimitedUntil).length;
    if (blocked === 0) return { pass: false, detail: "no projects marked rate-limited after 429" };
    if (callCount !== 2) return { pass: false, detail: `expected two provider calls before backoff blocked later projects, got ${callCount}` };

    return {
      pass: true,
      detail: `scanned ${projects.length} projects, ${blocked} blocked by delegate-backed quota gate, callCount=${callCount}`,
    };
  });
}

export async function checkProcessGrowthBound(hubRoot: string) {
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1, claude: 1 },
    runner: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    },
  });

  for (let i = 0; i < 20; i++) {
    const handle = await pool.acquire("codex");
    const st = recordValue(recordValue(pool.status().pools).codex);
    if (numberValue(st.active) > 1) {
      handle.release();
      return { pass: false, detail: `active=${st.active} exceeded limit=1 at iteration ${i}` };
    }
    handle.release();
  }

  let totalActive = 0;
  for (const p of Object.values(recordValue(pool.status().pools))) totalActive += numberValue(recordValue(p).active);

  if (totalActive !== 0) return { pass: false, detail: `leaked ${totalActive} active slots after 20 cycles` };

  const pools = recordValue(pool.status().pools);
  const codexActive = recordValue(pools.codex).active;
  const claudeActive = recordValue(pools.claude).active;
  return { pass: true, detail: `20 acquire/release cycles, active=0 after (codex=${codexActive}, claude=${claudeActive})` };
}

// ── Runner ───────────────────────────────────────────────────────────────────

export const ALL_CHECKS = [
  { name: "queue-integrity", fn: checkQueueIntegrity },
  { name: "queue-status-surfaces", fn: checkQueueStatusSurfaces },
  { name: "rate-limit-backoff", fn: checkRateLimitBackoff },
  { name: "concurrency-bounds", fn: checkConcurrencyBounds },
  { name: "multi-project-scan-429", fn: checkMultiProjectScanUnder429 },
  { name: "process-growth-bound", fn: checkProcessGrowthBound },
];

type HubRootFactory = string | (() => Promise<string | TemporaryWorkspace>);
type ReadinessCheck = {
  name: string;
  fn: (hubRoot: string) => Promise<unknown>;
};

function isTemporaryWorkspace(value: string | TemporaryWorkspace): value is TemporaryWorkspace {
  return typeof value !== "string";
}

export async function runIsolatedCheck(
  check: ReadinessCheck,
  isolatedResource: string | TemporaryWorkspace,
): Promise<LooseRecord> {
  const isolatedHub = isTemporaryWorkspace(isolatedResource)
    ? isolatedResource.rootPath
    : isolatedResource;
  let result: LooseRecord;
  try {
    result = { name: check.name, ...recordValue(await check.fn(isolatedHub)) };
  } catch (err: unknown) {
    result = { name: check.name, pass: false, detail: `UNEXPECTED: ${recordValue(err).message || err}` };
  }
  if (isTemporaryWorkspace(isolatedResource)) {
    try {
      await isolatedResource.cleanup();
    } catch (cleanupError) {
      result = {
        ...result,
        pass: false,
        detail: `${String(result.detail || "check completed")}; isolated Hub cleanup failed: ${describeError(cleanupError)}`,
        cleanupError,
      };
    }
  }
  return result;
}

export async function runChecks(hubRootFactory: HubRootFactory, opts: LooseRecord = {}) {
  const results = [];
  for (const check of ALL_CHECKS) {
    const isolatedResource = typeof hubRootFactory === "function" ? await hubRootFactory() : hubRootFactory;
    results.push(await runIsolatedCheck(check, isolatedResource));
  }
  return results;
}

export function formatResults(results: LooseRecord[], { json: asJson }: LooseRecord = {}) {
  if (asJson) return JSON.stringify(results, null, 2);

  const lines = [];
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? "PASS" : "FAIL";
    if (!r.pass) allPass = false;
    lines.push(`  [${icon}] ${r.name}: ${r.detail}`);
  }
  lines.push("");
  lines.push(allPass ? "  All checks passed." : "  Some checks FAILED.");
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: node scripts/validate-scan-readiness.js [options]

Options:
  --live            Validate against real hub root (requires --hub-root)
  --hub-root DIR    Use specific hub root (default: temp dir in dry-run)
  --json            Machine-readable JSON output
  --verbose         Verbose output
  --help            Show this help

Default mode is dry-run: uses temp dirs, no network, no real provider.
Use --live --hub-root DIR to validate real state.`);
    process.exit(0);
  }

  let hubRootOrFactory;
  if (opts.live) {
    const hubRoot = opts.hubRoot || resolveHubRoot();
    console.error(`[validate] Live mode: hub-root=${hubRoot}`);
    hubRootOrFactory = hubRoot;
  } else {
    if (opts.verbose) console.error("[validate] Dry-run mode: isolated temp dirs per check");
    hubRootOrFactory = makeTempHub;
  }

  const results = await runChecks(hubRootOrFactory, opts);
  console.log(formatResults(results, opts));

  const allPass = results.every((r) => r.pass);
  process.exit(allPass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err: any) => {
    console.error(`[validate] fatal: ${err.message}`);
    process.exit(2);
  });
}
