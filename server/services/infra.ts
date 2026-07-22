// ── infra.ts — merged: local-smoke, lease-manager, concurrency-limits, process-registry, index-freshness ──

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type LooseRecord } from "../../core/contracts/types.js";
import {
  captureProcessIdentity,
  killTree,
  sameProcessIdentity,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../../core/runtime/process-tree.js";
import { createTemporaryWorkspace } from "../../core/runtime/temporary-workspace.js";
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

function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key));
}

function positiveSafePid(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw Object.assign(new TypeError(`${label} must be a positive safe integer`), {
      code: "PROCESS_PID_INVALID",
      label,
      value,
    });
  }
  return value;
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

type FileLockOptions = LeaseLockOptions & {
  purpose?: string;
};

type LeaseRecord = {
  formatVersion: number;
  leaseId: string;
  jobId: string;
  phase: string;
  ownerPid: number;
  ownerHost: string;
  ownerToken: string;
  ownerIdentity: ProcessIdentity;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
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
  processSystem?: ProcessTreeSystem;
  graceMs?: number;
  forceVerifyMs?: number;
};

type ProcessSessionPin = {
  sessionId: string;
  phase: string;
  agentPid: number;
  pinnedAt: string;
};

type ProcessEntry = {
  formatVersion: number;
  jobId: string;
  project: string | null;
  phase: string | null;
  runnerPid: number;
  processIdentity: ProcessIdentity;
  treeId: string | null;
  childPids: number[];
  childIdentities: ProcessIdentity[];
  leaseId: string | null;
  startedAt: string;
  lastHeartbeat: string;
  status: string;
  exitCode: number | null;
  command: string | null;
  cwd: string | null;
  executorRoot: string | null;
  sessionPin?: ProcessSessionPin;
  liveness?: string;
  ageMs?: number | null;
  id?: string;
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

const DECOMPOSE_PROMPT_RE = "decomposing a task into structured acceptance-checklist items";
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
          name: "decompose",
          matchRegex: DECOMPOSE_PROMPT_RE,
          output: jsonEnvelope({
            status: "ok",
            decomposedItems: [
              {
                requirement: "README.md is updated by the local fake ACP smoke execution.",
                predicateId: "local-smoke-readme-change",
                verificationMethod: "static",
                allowedFiles: ["README.md"],
                sourceRefs: [{ kind: "task_text", locator: "task:0" }],
                expectedEvidence: "static scope probe confirming README.md was modified",
                requiresRealPathEvidence: false,
              },
            ],
          }),
        },
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
          writes: [
            {
              path: "{{worktree}}/README.md",
              content: "# Local Smoke Project\n\nFake ACP completed the local smoke path.\n",
            },
          ],
          output: jsonEnvelope({
            status: "ok",
            summary: "Fake ACP executed the smoke path and updated README.md.",
            tests: ["server/services/local-smoke.js: fake-acp full-chain smoke reached execute"],
            risks: ["Only the temporary smoke fixture README.md is changed."],
            checklistMapping: [
              { checklistId: "AC-001", changedFiles: ["README.md"] },
            ],
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
            checklistVerdict: {
              schemaVersion: 1,
              status: "pass",
              items: [
                {
                  checklistId: "AC-001",
                  result: "pass",
                  evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
                  actualResult: "README.md was updated by the fake ACP execution.",
                  reason: "The deterministic static probe observed README.md in the changed-file scope.",
                  fixScope: [],
                },
              ],
              blocking: [],
              fixScope: [],
              reason: "All required local smoke acceptance items passed.",
            },
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

async function collectArtifacts(hubRoot: string, project: string) {
  const wikiDir = path.join(hubRoot, "projects", project, "wiki");
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
  const workspace = await createTemporaryWorkspace({ prefix: "cpb-local-smoke-" });
  try {
    const tmpRoot = workspace.rootPath;
    const cpbRoot = path.join(tmpRoot, "cpb-root");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source-project");
    const scenarioFile = await writeTestAgentScenario(tmpRoot);
    const transcriptFile = path.join(tmpRoot, "test-acp-transcript.jsonl");
    const testAgentPath = path.join(root, "tests", "fixtures", "test-acp-agent.js");
    const testAgentArgs = JSON.stringify([testAgentPath, "--scenario-file", scenarioFile, "--transcript-file", transcriptFile]);

    await mkdir(cpbRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "README.md"), "# Local Smoke Project\n", "utf8");
    await writeFile(
      path.join(sourcePath, "package.json"),
      `${JSON.stringify({ name: "cpb-local-smoke-project", private: true }, null, 2)}\n`,
      "utf8",
    );
    const emptyGitConfig = path.join(tmpRoot, "empty-gitconfig");
    const disabledGitHooks = path.join(tmpRoot, "disabled-git-hooks");
    await writeFile(emptyGitConfig, "", "utf8");
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: disabledGitHooks,
    };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete gitEnv[key];
    }
    await runCommand("git", ["init", "-q"], { cwd: sourcePath, env: gitEnv });
    await runCommand("git", ["add", "--", "README.md", "package.json"], { cwd: sourcePath, env: gitEnv });
    await runCommand(
      "git",
      [
        "-c",
        "user.name=CodePatchBay Local Smoke",
        "-c",
        "user.email=local-smoke@invalid.example",
        "commit",
        "-q",
        "-m",
        "Initialize local smoke fixture",
      ],
      { cwd: sourcePath, env: gitEnv },
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
      // The smoke scenario includes a deterministic decomposition response and
      // asserts the resulting allowed-file contract. Test runners disable
      // decomposition globally for speed, so opt this end-to-end smoke back in
      // rather than falling through to an unmapped generic checklist.
      CPB_CHECKLIST_DECOMPOSE: "1",
      CPB_PHASE_RETRY_MAX: "0",
      CPB_PHASE_FEEDBACK_RETRY_MAX: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: testAgentArgs,
      CPB_USE_WORKTREE: "0",
      ...(codegraph ? {} : { CPB_CODEGRAPH_ENABLED: "0" }),
    };

    const cli = path.join(root, "cli", "cpb.js");
    await runCommand(process.execPath, [cli, "init", sourcePath, project], { cwd: root, env });
    await runCommand("git", ["add", "--all"], { cwd: sourcePath, env: gitEnv });
    await runCommand(
      "git",
      [
        "-c",
        "user.name=CodePatchBay Local Smoke",
        "-c",
        "user.email=local-smoke@invalid.example",
        "commit",
        "-q",
        "-m",
        "Record initialized CPB smoke project",
      ],
      { cwd: sourcePath, env: gitEnv },
    );
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

    const artifacts = await collectArtifacts(hubRoot, project);
    assertArtifacts(artifacts);

    const verdictName = artifacts.outputs.find((entry) => /^verdict-\d+\.md$/.test(entry));
    const verdictPath = path.join(hubRoot, "projects", project, "wiki", "outputs", verdictName);
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
      await workspace.cleanup();
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

function commonPathAncestor(left: string, right: string) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  const leftRoot = path.parse(leftResolved).root;
  if (leftRoot !== path.parse(rightResolved).root) return leftRoot;
  const leftParts = leftResolved.slice(leftRoot.length).split(path.sep).filter(Boolean);
  const rightParts = rightResolved.slice(leftRoot.length).split(path.sep).filter(Boolean);
  const shared: string[] = [];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) break;
    shared.push(leftParts[index]);
  }
  return path.join(leftRoot, ...shared);
}

async function nearestExistingDirectory(candidate: string, invalidCode = "EDIRECTORYUNSAFE") {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      const state = await lstat(current);
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw Object.assign(new Error(`storage authority anchor is not a directory: ${current}`), {
          code: invalidCode,
          directory: current,
        });
      }
      return current;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function prepareStorageDirectory(
  cpbRoot: string,
  storageBase: string,
  child: string,
  invalidCode: string,
) {
  const base = path.resolve(storageBase);
  try {
    const baseState = await lstat(base);
    if (baseState.isSymbolicLink() || !baseState.isDirectory()) {
      throw Object.assign(new Error(`storage root is unsafe: ${base}`), {
        code: invalidCode,
        directory: base,
      });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  let anchor = commonPathAncestor(path.resolve(cpbRoot), base);
  if (anchor === base) anchor = path.dirname(base);
  anchor = await nearestExistingDirectory(anchor, invalidCode);
  const canonicalAnchor = await realpath(anchor);
  const relativeBase = path.relative(anchor, base);
  if (relativeBase.startsWith("..") || path.isAbsolute(relativeBase)) {
    throw Object.assign(new Error(`storage root escaped its authority anchor: ${base}`), {
      code: invalidCode,
      directory: base,
    });
  }

  const parts = [...relativeBase.split(path.sep).filter(Boolean), child];
  let current = canonicalAnchor;
  for (const part of parts) {
    current = path.join(current, part);
    let state: Awaited<ReturnType<typeof lstat>>;
    try {
      state = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      state = await lstat(current);
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw Object.assign(new Error(`storage directory component is unsafe: ${current}`), {
        code: invalidCode,
        directory: current,
      });
    }
  }

  const canonical = await realpath(current);
  if (canonical !== current) {
    throw Object.assign(new Error(`storage directory resolved through a link: ${current}`), {
      code: invalidCode,
      directory: current,
    });
  }
  return current;
}

const DEFAULT_LOCK_TTL_MS = 30_000;
const MAX_LOCK_TTL_MS = 5 * 60_000;
const MAX_PROCESS_STOP_WAIT_MS = 5 * 60_000;
const FENCE_PORT_COUNT = 32;
const FENCE_PROTOCOL = "cpb-file-fence-v2";
const FENCE_CONNECT_TIMEOUT_MS = 150;
const LOCK_METADATA_MAX_BYTES = 16 * 1024;
const LEASE_RECORD_MAX_BYTES = 64 * 1024;
const PROCESS_RECORD_MAX_BYTES = 256 * 1024;

export type InfraLockTestHooks = {
  afterQuarantineRename?: (context: { lockDir: string; quarantineDir: string }) => void | Promise<void>;
  afterLockMetadataLstat?: (context: { metadataFile: string }) => void | Promise<void>;
  afterLeaseLstat?: (context: { leaseFile: string }) => void | Promise<void>;
  afterProcessEntryLstat?: (context: { processFile: string }) => void | Promise<void>;
  beforeJsonPublishRename?: (context: { file: string; tempFile: string }) => void | Promise<void>;
  afterJsonPublishRename?: (context: { file: string }) => void | Promise<void>;
  beforeDurableRemoveRename?: (context: { target: string; quarantinePath: string }) => void | Promise<void>;
  afterDurableRemoveRename?: (context: { target: string; quarantinePath: string }) => void | Promise<void>;
  afterFailedJsonTempRename?: (context: { file: string; tempFile: string; quarantinePath: string }) => void | Promise<void>;
  beforeProcessAudit?: (context: { type: string; jobId: string; project: string }) => void | Promise<void>;
  afterCanonicalFenceResolutionBeforeAuthorityOpen?: (context: {
    requestedFile: string;
    canonicalFile: string;
    requestedParent: string;
    canonicalParent: string;
  }) => void | Promise<void>;
  beforeProcessFenceRelease?: (context: {
    canonicalFile: string;
    lockDir: string;
    acquired: boolean;
  }) => void | Promise<void>;
  captureProcessIdentity?: (pid: number, processSystem?: ProcessTreeSystem) => ProcessIdentity | null;
  redisLeaseBackend?: () => Promise<HubRedisStateBackend | null> | HubRedisStateBackend | null;
  durabilityFault?: string;
};

const infraLockTestHookStorage = new AsyncLocalStorage<InfraLockTestHooks>();

function infraLockTestHooks() {
  return infraLockTestHookStorage.getStore() || {};
}

export function withInfraLockTestHooksForTests<T>(
  hooks: InfraLockTestHooks,
  callback: () => T,
) {
  return infraLockTestHookStorage.run(hooks, callback);
}

function validateLeaseId(leaseId: unknown) {
  if (
    typeof leaseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(leaseId)
  ) {
    throw new Error("invalid leaseId");
  }
}

async function leaseFileFor(cpbRoot: string, leaseId: string, opts: RuntimeStorageOptions = {}) {
  validateLeaseId(leaseId);

  const leasesRoot = await prepareStorageDirectory(
    cpbRoot,
    leaseBase(cpbRoot, opts),
    "leases",
    "EDIRECTORYUNSAFE",
  );
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
  const testBackend = infraLockTestHooks().redisLeaseBackend;
  if (testBackend) return await testBackend();
  const hubRoot = process.env.CPB_HUB_ROOT;
  const configFile = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  if (!hubRoot || !configFile) return null;
  return await openPinnedHubRedisStateBackend({ configFile, hubRoot });
}

async function assertNoLocalLeaseState(cpbRoot: string, opts: RuntimeStorageOptions) {
  const root = await prepareStorageDirectory(
    cpbRoot,
    leaseBase(cpbRoot, opts),
    "leases",
    "HUB_LEASE_MIGRATION_LOCAL_STATE_UNSAFE",
  );
  const entries = await readDirectoryNamesNoFollow(root, "HUB_LEASE_MIGRATION_LOCAL_STATE_UNSAFE");
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
  if (!validPersistentLeaseRecord(lease, leaseId, true)) {
    throw Object.assign(new Error(`invalid Redis lease: ${leaseId}`), { code: "HUB_STATE_RECORD_INVALID" });
  }
  return lease;
}

function expiresAtFor(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function leaseOwnerTokenFor(_cpbRoot: string, _leaseId: string, suppliedToken: string | undefined) {
  return suppliedToken;
}

function assertLeaseOwner(lease: LeaseRecord, ownerToken: string | undefined) {
  if (lease.ownerToken !== undefined && lease.ownerToken !== ownerToken) {
    throw new Error("lease owner mismatch");
  }
}

function durabilityFaultEnabled(point: string, file: string) {
  const value = infraLockTestHooks().durabilityFault;
  return value === point || value === `${point}:${path.basename(file)}`;
}

function injectedDurabilityFault(point: string, file: string) {
  return Object.assign(new Error(`injected durability fault at ${point}: ${file}`), {
    code: "EINJECTED_DURABILITY_FAULT",
  });
}

async function fsyncDirectory(dir: string) {
  const authority = await openDirectoryAuthorityChain(dir, "EDIRECTORYUNSAFE");
  let primaryError: unknown = null;
  try {
    await authority.assert();
    await authority.entries[authority.entries.length - 1].handle.sync();
    await authority.assert();
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await authority.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `directory fsync and close failed: ${dir}`, {
        cause: primaryError,
      }),
      { code: errorCode(primaryError) || "EDIRECTORYUNSAFE", directory: dir },
    );
  }
  if (closeError) throw closeError;
}

async function readDirectoryNamesNoFollow(directory: string, invalidCode: string) {
  let authority: DirectoryAuthority;
  try {
    authority = await openDirectoryAuthorityChain(directory, invalidCode);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  let names: string[] = [];
  let primaryError: unknown = null;
  try {
    await authority.assert();
    names = await readdir(directory);
    await authority.assert();
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await authority.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `directory read and close failed: ${directory}`, {
        cause: primaryError,
      }),
      { code: errorCode(primaryError) || invalidCode, directory },
    );
  }
  if (closeError) throw closeError;
  return names;
}

async function assertSameDirectoryAuthority(
  directory: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  code = "EDIRECTORYUNSAFE",
) {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(directory);
  } catch (cause) {
    throw Object.assign(new Error(`directory authority became unavailable: ${directory}`, { cause }), {
      code,
      directory,
    });
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectoryIdentity(expected, current)) {
    throw Object.assign(new Error(`directory authority changed: ${directory}`), { code, directory });
  }
}

async function isolateFailedJsonTemp(
  file: string,
  tempFile: string,
  expected: FileGeneration,
  authority: DirectoryAuthority,
) {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(tempFile);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!safeRegularFile(current) || !sameFileGeneration(expected, generationFromStat(current))) {
    throw Object.assign(new Error(`durable JSON temp successor preserved: ${tempFile}`), {
      code: "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { tempFile },
    });
  }
  // A failed publication can legitimately observe a target-directory entry
  // change (for example, the successor that caused the publication to abort).
  // Rebind only after proving both the directory object and our temp generation
  // are still exact; mode/owner changes remain fatal.
  await authority.recaptureOwnedMutation(path.dirname(file));
  const quarantinePath = `${tempFile}.failed-${Date.now()}-${randomUUID()}`;
  await rename(tempFile, quarantinePath);
  await authority.recaptureOwnedMutation(path.dirname(file));
  const quarantined = await lstat(quarantinePath);
  if (!safeRegularFile(quarantined) || !sameFileAcrossRename(expected, generationFromStat(quarantined))) {
    throw Object.assign(new Error(`durable JSON temp quarantine changed: ${quarantinePath}`), {
      code: "DURABLE_JSON_TEMP_LINEAGE_LOST",
      committed: false,
      quarantinePreserved: false,
      lineageLost: true,
      recoveryPaths: {},
    });
  }
  const quarantinedGeneration = generationFromStat(quarantined);
  await infraLockTestHooks().afterFailedJsonTempRename?.({ file, tempFile, quarantinePath });
  let afterHook: Awaited<ReturnType<typeof lstat>>;
  try {
    afterHook = await lstat(quarantinePath);
  } catch (cause) {
    throw Object.assign(new Error(`durable JSON temp quarantine disappeared: ${quarantinePath}`, { cause }), {
      code: "DURABLE_JSON_TEMP_LINEAGE_LOST",
      committed: false,
      quarantinePreserved: false,
      lineageLost: true,
      recoveryPaths: {},
    });
  }
  if (!safeRegularFile(afterHook) || !sameFileGeneration(quarantinedGeneration, generationFromStat(afterHook))) {
    throw Object.assign(new Error(`durable JSON temp quarantine changed after isolation: ${quarantinePath}`), {
      code: "DURABLE_JSON_TEMP_LINEAGE_LOST",
      committed: false,
      quarantinePreserved: false,
      lineageLost: true,
      recoveryPaths: {},
    });
  }
  await authority.recaptureOwnedMutation(path.dirname(file));
  await authority.entries[authority.entries.length - 1].handle.sync();
  await authority.assert();
  const final = await lstat(quarantinePath);
  if (!safeRegularFile(final) || !sameFileGeneration(quarantinedGeneration, generationFromStat(final))) {
    throw Object.assign(new Error(`durable JSON temp quarantine changed after sync: ${quarantinePath}`), {
      code: "DURABLE_JSON_TEMP_LINEAGE_LOST",
      committed: false,
      quarantinePreserved: false,
      lineageLost: true,
      recoveryPaths: {},
    });
  }
  return quarantinePath;
}

async function durableAtomicWriteJson(
  file: string,
  value: unknown,
  ambiguityCode = "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS",
  expectedTargetGeneration?: FileGeneration | null,
) {
  const dir = path.dirname(file);
  const parentAuthority = await openDirectoryAuthorityChain(dir, "DURABLE_JSON_PARENT_UNSAFE");
  await parentAuthority.assert();
  await parentAuthority.entries[parentAuthority.entries.length - 1].handle.sync();
  await parentAuthority.assert();
  const tempFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error(`strict no-follow JSON publication is unavailable: ${tempFile}`), {
      code: "DURABLE_JSON_TEMP_UNSAFE",
      committed: false,
    });
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let tempGeneration: FileGeneration | null = null;
  let publishedGeneration: FileGeneration | null = null;
  let renamed = false;
  let primaryError: unknown = null;
  try {
    handle = await open(
      tempFile,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await parentAuthority.recaptureOwnedMutation(dir);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const opened = await handle.stat();
    if (!safeRegularFile(opened)) {
      throw Object.assign(new Error(`durable JSON temp is unsafe: ${tempFile}`), {
        code: "DURABLE_JSON_TEMP_UNSAFE",
      });
    }
    tempGeneration = generationFromStat(opened);
    await handle.close();
    handle = null;
    await infraLockTestHooks().beforeJsonPublishRename?.({ file, tempFile });
    let beforeRename: Awaited<ReturnType<typeof lstat>>;
    try {
      beforeRename = await lstat(tempFile);
    } catch (error) {
      // Surface an ancestor/path-authority replacement instead of the incidental
      // ENOENT produced by resolving the temp name through a successor path.
      await parentAuthority.assert();
      throw error;
    }
    if (!safeRegularFile(beforeRename) || !sameFileGeneration(tempGeneration, generationFromStat(beforeRename))) {
      throw Object.assign(new Error(`durable JSON temp changed before publish: ${tempFile}`), {
        code: "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED",
        successorPreserved: true,
      });
    }
    if (expectedTargetGeneration !== undefined) {
      const targetGeneration = await fileGeneration(file);
      if (!sameFileGeneration(expectedTargetGeneration, targetGeneration)) {
        throw Object.assign(new Error(`durable JSON target changed before publish: ${file}`), {
          code: "DURABLE_JSON_TARGET_SUCCESSOR_PRESERVED",
          successorPreserved: true,
        });
      }
    }
    await parentAuthority.assert();
    await rename(tempFile, file);
    renamed = true;
    await parentAuthority.recaptureOwnedMutation(dir);
    const published = await lstat(file);
    if (!safeRegularFile(published) || !sameFileAcrossRename(tempGeneration, generationFromStat(published))) {
      throw Object.assign(new Error(`durable JSON publication changed after rename: ${file}`), {
        code: "DURABLE_JSON_COMMITTED_PUBLICATION_RACE",
      });
    }
    publishedGeneration = generationFromStat(published);
    await infraLockTestHooks().afterJsonPublishRename?.({ file });
    if (durabilityFaultEnabled("after-json-rename", file)) {
      throw injectedDurabilityFault("after-json-rename", file);
    }
    await parentAuthority.entries[parentAuthority.entries.length - 1].handle.sync();
    await parentAuthority.assert();
    const final = await lstat(file);
    if (!safeRegularFile(final) || !sameFileGeneration(publishedGeneration, generationFromStat(final))) {
      throw Object.assign(new Error(`durable JSON publication changed after directory sync: ${file}`), {
        code: "DURABLE_JSON_COMMITTED_PUBLICATION_RACE",
      });
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (handle) {
    if (!tempGeneration) {
      try {
        const opened = await handle.stat();
        if (safeRegularFile(opened)) tempGeneration = generationFromStat(opened);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    handle = null;
  }
  let failedTempPath: string | null = null;
  if (!renamed && tempGeneration) {
    try {
      failedTempPath = await isolateFailedJsonTemp(file, tempFile, tempGeneration, parentAuthority);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await parentAuthority.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (primaryError) {
    if (renamed) {
      const publicationRace = errorCode(primaryError) === "DURABLE_JSON_COMMITTED_PUBLICATION_RACE";
      const currentGeneration = await fileGeneration(file).catch(() => null);
      const committedPathVerified = publishedGeneration !== null
        && sameFileGeneration(publishedGeneration, currentGeneration);
      throw Object.assign(
        new AggregateError([primaryError, ...cleanupErrors], publicationRace
          ? `durable JSON publication committed but pathname authority changed: ${file}`
          : `durable JSON write committed but directory durability is ambiguous: ${file}`, {
          cause: primaryError,
        }),
        {
          code: publicationRace ? "DURABLE_JSON_COMMITTED_PUBLICATION_RACE" : ambiguityCode,
          primaryError,
          cleanupErrors,
          committed: true,
          committedPath: committedPathVerified ? file : null,
          path: file,
          successorPreserved: publicationRace || !committedPathVerified,
          quarantinePreserved: false,
          lineageLost: !committedPathVerified,
          recoveryPaths: committedPathVerified ? { path: file } : {},
        },
      );
    }
    if (cleanupErrors.length === 0) {
      if (!failedTempPath) throw primaryError;
      throw Object.assign(new Error(`durable JSON publication failed and its temp evidence was isolated: ${file}`, {
        cause: primaryError,
      }), {
        code: errorCode(primaryError) || "DURABLE_JSON_PUBLICATION_FAILED",
        primaryError,
        committed: false,
        cleanupCommitted: true,
        quarantinePreserved: true,
        successorPreserved: Boolean(primaryError && typeof primaryError === "object"
          && (primaryError as { successorPreserved?: unknown }).successorPreserved),
        recoveryPaths: { failedTempPath },
      });
    }
    const lineageLost = cleanupErrors.some((error) => errorCode(error) === "DURABLE_JSON_TEMP_LINEAGE_LOST");
    const successorPreserved = cleanupErrors.some((error) => errorCode(error) === "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED");
    throw Object.assign(
      new AggregateError([primaryError, ...cleanupErrors], `durable JSON write failed and evidence was preserved: ${file}`, {
        cause: primaryError,
      }),
      {
        code: lineageLost
          ? "DURABLE_JSON_TEMP_LINEAGE_LOST"
          : successorPreserved ? "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED" : "DURABLE_JSON_TEMP_CLEANUP_FAILED",
        primaryError,
        cleanupErrors,
        committed: false,
        successorPreserved,
        lineageLost: lineageLost || !failedTempPath,
        recoveryPaths: failedTempPath ? { failedTempPath } : {},
      },
    );
  }
  if (cleanupErrors.length > 0) {
    const currentGeneration = renamed ? await fileGeneration(file).catch(() => null) : null;
    const committedPathVerified = renamed
      && publishedGeneration !== null
      && sameFileGeneration(publishedGeneration, currentGeneration);
    throw Object.assign(new AggregateError(cleanupErrors, `durable JSON cleanup failed: ${file}`), {
      code: "DURABLE_JSON_TEMP_CLEANUP_FAILED",
      cleanupErrors,
      committed: renamed,
      committedPath: committedPathVerified ? file : null,
      path: file,
      successorPreserved: renamed && !committedPathVerified,
      quarantinePreserved: false,
      lineageLost: renamed && !committedPathVerified,
      recoveryPaths: committedPathVerified ? { path: file } : {},
    });
  }
}

async function atomicWriteJson(file: string, value: unknown, expectedTargetGeneration?: FileGeneration | null) {
  await durableAtomicWriteJson(file, value, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS", expectedTargetGeneration);
}

async function removePathDurably(
  target: string,
  options: {
    force?: boolean;
    faultFile?: string;
    faultPoint?: string;
    ambiguityCode?: string;
    expectedGeneration?: FileGeneration | null;
  } = {},
) {
  const parent = path.dirname(target);
  const parentAuthority = await openDirectoryAuthorityChain(parent, "DURABLE_REMOVE_PARENT_UNSAFE");
  let authorityClosed = false;
  async function closeAuthority() {
    if (authorityClosed) return;
    authorityClosed = true;
    await parentAuthority.close();
  }
  await parentAuthority.assert();
  await parentAuthority.entries[parentAuthority.entries.length - 1].handle.sync();
  await parentAuthority.assert();
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT" && options.force === true) {
      await closeAuthority();
      return { removed: false, committedPath: null, recoveryPaths: [] as string[] };
    }
    await closeAuthority().catch(() => undefined);
    throw error;
  }
  if (!safeRegularFile(before)) {
    await closeAuthority().catch(() => undefined);
    throw Object.assign(new Error(`durable removal requires an unlinked regular file: ${target}`), {
      code: "DURABLE_REMOVE_UNSAFE",
      committed: false,
      recoveryPaths: { canonical: target },
    });
  }
  const expected = generationFromStat(before);
  if (options.expectedGeneration !== undefined && !sameFileGeneration(options.expectedGeneration, expected)) {
    await closeAuthority().catch(() => undefined);
    throw Object.assign(new Error(`durable removal target successor preserved: ${target}`), {
      code: "DURABLE_REMOVE_SUCCESSOR_PRESERVED",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { canonical: target },
    });
  }
  const quarantinePath = `${target}.removed-${Date.now()}-${randomUUID()}`;
  let renamed = false;
  let quarantineGeneration: FileGeneration | null = null;
  let primaryError: unknown = null;
  const faultFile = options.faultFile ?? target;
  try {
    await infraLockTestHooks().beforeDurableRemoveRename?.({ target, quarantinePath });
    const preRename = await lstat(target);
    if (!safeRegularFile(preRename) || !sameFileGeneration(expected, generationFromStat(preRename))) {
      throw Object.assign(new Error(`durable removal target changed before isolation: ${target}`), {
        code: "DURABLE_REMOVE_SUCCESSOR_PRESERVED",
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: target },
      });
    }
    await parentAuthority.assert();
    await rename(target, quarantinePath);
    renamed = true;
    await parentAuthority.recaptureOwnedMutation(parent);
    const quarantined = await lstat(quarantinePath);
    if (!safeRegularFile(quarantined) || !sameFileAcrossRename(expected, generationFromStat(quarantined))) {
      throw Object.assign(new Error(`durable removal quarantine changed: ${quarantinePath}`), {
        code: "DURABLE_REMOVE_QUARANTINE_PRESERVED",
      });
    }
    quarantineGeneration = generationFromStat(quarantined);
    await infraLockTestHooks().afterDurableRemoveRename?.({ target, quarantinePath });
    const faultPoint = options.faultPoint ?? "after-remove";
    if (durabilityFaultEnabled(faultPoint, faultFile)) {
      throw injectedDurabilityFault(faultPoint, faultFile);
    }
    let canonicalSuccessor = false;
    try {
      const successor = await lstat(target);
      if (!safeRegularFile(successor)) {
        throw Object.assign(new Error(`durable removal successor is unsafe: ${target}`), {
          code: "DURABLE_REMOVE_SUCCESSOR_PRESERVED",
          successorPreserved: true,
        });
      }
      canonicalSuccessor = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (canonicalSuccessor) await parentAuthority.recaptureOwnedMutation(parent);
    else await parentAuthority.assert();
    await parentAuthority.entries[parentAuthority.entries.length - 1].handle.sync();
    await parentAuthority.assert();
    const final = await lstat(quarantinePath);
    if (!safeRegularFile(final) || !sameFileGeneration(quarantineGeneration, generationFromStat(final))) {
      throw Object.assign(new Error(`durable removal quarantine changed after sync: ${quarantinePath}`), {
        code: "DURABLE_REMOVE_QUARANTINE_PRESERVED",
      });
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await closeAuthority();
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError([primaryError, error], `durable removal and authority close failed: ${target}`, { cause: primaryError })
      : error;
  }
  if (primaryError) {
    if (!renamed) throw primaryError;
    const successor = await fileGeneration(target).catch(() => null);
    let quarantineVerified = false;
    if (quarantineGeneration) {
      try {
        const current = await lstat(quarantinePath);
        quarantineVerified = safeRegularFile(current)
          && sameFileGeneration(quarantineGeneration, generationFromStat(current));
      } catch {}
    }
    const primaryCode = String(errorCode(primaryError) || "");
    const preserveCode = primaryCode.startsWith("DURABLE_REMOVE_") ? primaryCode : "";
    throw Object.assign(
      new Error(`durable removal committed with preserved evidence: ${quarantinePath}: ${errorMessage(primaryError)}`, {
        cause: primaryError,
      }),
      {
        code: quarantineVerified
          ? preserveCode || options.ambiguityCode || "DURABLE_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS"
          : "DURABLE_REMOVE_LINEAGE_LOST",
        committed: true,
        committedPath: quarantineVerified ? quarantinePath : null,
        path: target,
        quarantinePreserved: quarantineVerified,
        successorPreserved: successor !== null,
        lineageLost: !quarantineVerified,
        recoveryPaths: {
          ...(successor === null ? {} : { canonical: target }),
          ...(quarantineVerified ? { quarantine: quarantinePath } : {}),
        },
      },
    );
  }
  const successorPreserved = await fileGeneration(target) !== null;
  return {
    removed: true,
    committedPath: quarantineGeneration ? quarantinePath : null,
    quarantinePreserved: Boolean(quarantineGeneration),
    successorPreserved,
    lineageLost: !quarantineGeneration,
    recoveryPaths: successorPreserved ? [quarantinePath, target] : [quarantinePath],
  };
}

function validCanonicalTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

function epochMatchesTimestamp(value: unknown, timestamp: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || typeof timestamp !== "string") return false;
  try {
    return new Date(Number(value)).toISOString() === timestamp;
  } catch {
    return false;
  }
}

const LEASE_RECORD_REQUIRED_KEYS = [
  "formatVersion",
  "leaseId",
  "jobId",
  "phase",
  "ownerPid",
  "ownerHost",
  "ownerToken",
  "ownerIdentity",
  "acquiredAt",
  "heartbeatAt",
  "expiresAt",
] as const;

function validPersistentLeaseRecord(lease: LeaseRecord, expectedLeaseId: string, redis: boolean) {
  const ownerPid = lease.ownerPid;
  if (
    !hasExactKeys(
      lease,
      redis ? [...LEASE_RECORD_REQUIRED_KEYS, "expiresAtMs"] : LEASE_RECORD_REQUIRED_KEYS,
      redis ? [] : ["expiresAtMs"],
    )
    || lease.formatVersion !== LEASE_FORMAT_VERSION
    || lease.leaseId !== expectedLeaseId
    || !nonEmptyString(lease.jobId)
    || !nonEmptyString(lease.phase)
    || typeof ownerPid !== "number"
    || !Number.isSafeInteger(ownerPid)
    || ownerPid <= 0
    || !nonEmptyString(lease.ownerHost)
    || !nonEmptyString(lease.ownerToken)
    || !registeredProcessIdentity(lease.ownerIdentity, ownerPid)
    || !validCanonicalTimestamp(lease.acquiredAt)
    || !validCanonicalTimestamp(lease.heartbeatAt)
    || !validCanonicalTimestamp(lease.expiresAt)
  ) return false;
  if (!redis) {
    return lease.expiresAtMs === undefined
      || epochMatchesTimestamp(lease.expiresAtMs, lease.expiresAt);
  }
  return epochMatchesTimestamp(lease.expiresAtMs, lease.expiresAt);
}

function parseLeaseRecord(raw: string, file: string): LeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw invalidFileRead(`lease record is corrupt JSON: ${file}`, "ELEASEINVALID", cause);
  }
  const lease = recordValue(parsed) as LeaseRecord;
  const expectedLeaseId = path.basename(file, ".json");
  if (!validPersistentLeaseRecord(lease, expectedLeaseId, false)) {
    throw invalidFileRead(`lease record is invalid: ${file}`, "ELEASEINVALID");
  }
  return lease;
}

async function readLeaseFileSnapshot(file: string): Promise<{ lease: LeaseRecord; generation: FileGeneration } | null> {
  try {
    const snapshot = await readBoundedNoFollowFileSnapshot(file, {
      maxBytes: LEASE_RECORD_MAX_BYTES,
      kind: "lease record",
      invalidCode: "ELEASEINVALID",
      afterLstat: async () => {
        await infraLockTestHooks().afterLeaseLstat?.({ leaseFile: file });
      },
    });
    return { lease: parseLeaseRecord(snapshot.raw, file), generation: snapshot.generation };
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function readLeaseFile(file: string): Promise<LeaseRecord | null> {
  return (await readLeaseFileSnapshot(file))?.lease ?? null;
}

function lockTtlMsFor(lockTtlMs: unknown): number {
  const envValue = process.env.CPB_LEASE_LOCK_TTL_MS;
  const candidate = lockTtlMs !== undefined
    ? lockTtlMs
    : envValue !== undefined && envValue !== ""
      ? Number(envValue)
      : DEFAULT_LOCK_TTL_MS;
  if (
    typeof candidate !== "number"
    || !Number.isFinite(candidate)
    || !Number.isInteger(candidate)
    || candidate <= 0
    || candidate > MAX_LOCK_TTL_MS
  ) {
    throw Object.assign(new RangeError(`lockTtlMs must be an integer between 1 and ${MAX_LOCK_TTL_MS}`), {
      code: "ELOCKTTLINVALID",
      lockTtlMs,
    });
  }
  return candidate;
}

function leaseTtlMsFor(ttlMs: unknown) {
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw Object.assign(new RangeError("ttlMs must be a positive safe integer"), {
      code: "ELEASETTLINVALID",
      ttlMs,
    });
  }
  return ttlMs;
}

function processStopWaitMs(value: unknown, label: "graceMs" | "forceVerifyMs") {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
    || value > MAX_PROCESS_STOP_WAIT_MS
  ) {
    throw Object.assign(
      new RangeError(`${label} must be an integer between 0 and ${MAX_PROCESS_STOP_WAIT_MS}`),
      { code: "PROCESS_STOP_TIMING_INVALID", label, value },
    );
  }
  return value;
}

function combineFileLockErrors(message: string, errors: unknown[]) {
  const present = errors.filter(Boolean);
  if (present.length === 1) return present[0];
  const primary = present[0];
  const primaryMetadata = primary && typeof primary === "object"
    ? Object.fromEntries([
      "code",
      "committed",
      "committedPath",
      "path",
      "recoveryPaths",
      "successorPreserved",
      "quarantinePreserved",
      "lineageLost",
      "statusCommitted",
      "statusCommitState",
      "durableStatus",
      "candidatePids",
      "attemptedPids",
      "signaledPids",
      "verifiedStoppedPids",
      "signalOutcomeUnknownPids",
    ].filter((key) => key in primary).map((key) => [key, (primary as Record<string, unknown>)[key]]))
    : {};
  return Object.assign(
    new AggregateError(present, `${message}: ${present.map(errorMessage).join("; ")}`, { cause: primary }),
    primaryMetadata,
    { primaryError: primary, errors: present },
  );
}

function osFenceKey(file: string, purpose: string) {
  return createHash("sha256")
    .update(`${path.resolve(file)}\0${purpose}\0cpb-file-fence-key-v2`)
    .digest("hex");
}

function osFencePorts(file: string, purpose: string) {
  const ports: number[] = [];
  for (let index = 0; ports.length < FENCE_PORT_COUNT; index += 1) {
    const digest = createHash("sha256")
      .update(`${path.resolve(file)}\0${purpose}\0cpb-file-fence-port-v2\0${index}`)
      .digest();
    const port = 49_152 + (digest.readUInt16BE(0) % 16_384);
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function closeFenceServer(server: net.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startFenceServer(port: number, ownerKey: string) {
  const server = net.createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(FENCE_CONNECT_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      if (data.trim() === `${FENCE_PROTOCOL}? ${ownerKey}`) {
        socket.end(`${FENCE_PROTOCOL}! ${ownerKey}\n`);
      } else {
        socket.destroy();
      }
    });
  });
  server.unref();
  const result = await new Promise<{ error: NodeJS.ErrnoException | null }>((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve({ error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ error: null });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  if (result.error) {
    await closeFenceServer(server).catch(() => undefined);
    throw result.error;
  }
  return server;
}

async function queryFencePort(port: number, ownerKey: string): Promise<"same" | "unrelated" | "indeterminate"> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    function finish(value: "same" | "unrelated" | "indeterminate") {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    }
    socket.setEncoding("utf8");
    socket.setTimeout(FENCE_CONNECT_TIMEOUT_MS, () => finish("indeterminate"));
    socket.on("connect", () => {
      socket.write(`${FENCE_PROTOCOL}? ${ownerKey}\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const line = data.trim();
      if (line === `${FENCE_PROTOCOL}! ${ownerKey}`) finish("same");
      else finish("unrelated");
    });
    socket.on("end", () => finish(data.length > 0 ? "unrelated" : "unrelated"));
    socket.on("close", () => finish(data.length > 0 ? "unrelated" : "unrelated"));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") finish("unrelated");
      else finish("indeterminate");
    });
  });
}

async function acquireOsProcessFence(file: string, { purpose = "file", lockTtlMs }: FileLockOptions = {}) {
  const ports = osFencePorts(file, purpose);
  const ownerKey = osFenceKey(file, purpose);
  const deadline = Date.now() + Math.max(1, lockTtlMsFor(lockTtlMs));
  for (;;) {
    let sameOwnerBusy = false;
    for (const port of ports) {
      try {
        const server = await startFenceServer(port, ownerKey);
        const runtimeErrors: unknown[] = [];
        server.on("error", (error) => {
          runtimeErrors.push(error);
        });
        return async () => {
          let closeError: unknown = null;
          try {
            await closeFenceServer(server);
          } catch (error) {
            closeError = error;
          }
          if (runtimeErrors.length > 0 || closeError) {
            throw combineFileLockErrors("file process fence release failed", [...runtimeErrors, closeError]);
          }
        };
      } catch (error) {
        if (errorCode(error) !== "EADDRINUSE") throw error;
        const owner = await queryFencePort(port, ownerKey);
        if (owner === "same") {
          sameOwnerBusy = true;
          break;
        }
        if (owner === "indeterminate") {
          throw Object.assign(new Error(`file lock fence indeterminate on port ${port}: ${path.basename(file)}`), { code: "ELOCKBUSY" });
        }
      }
    }
    if (Date.now() >= deadline) {
      throw Object.assign(
        new Error(`${sameOwnerBusy ? "file lock busy" : "file lock fence namespace exhausted"}: ${path.basename(file)}`),
        { code: "ELOCKBUSY" },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function generationFromStat(current: Awaited<ReturnType<typeof lstat>>) {
  return {
    dev: current.dev,
    ino: current.ino,
    nlink: current.nlink,
    mode: current.mode,
    uid: current.uid,
    gid: current.gid,
    size: current.size,
    mtimeMs: current.mtimeMs,
    ctimeMs: current.ctimeMs,
    birthtimeMs: current.birthtimeMs,
  };
}

type FileGeneration = ReturnType<typeof generationFromStat>;

function safeRegularFile(current: Awaited<ReturnType<typeof lstat>>) {
  return current.isFile() && !current.isSymbolicLink() && current.nlink === 1;
}

function sameDirectoryIdentity(
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<typeof lstat>>,
) {
  return expected.isDirectory()
    && actual.isDirectory()
    && !expected.isSymbolicLink()
    && !actual.isSymbolicLink()
    && sameStatGeneration(expected, actual);
}

async function fileGeneration(file: string) {
  try {
    const current = await lstat(file);
    return generationFromStat(current);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function invalidFileRead(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message), {
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalidLockMetadata(message: string, cause?: unknown) {
  return invalidFileRead(message, "ELOCKINVALID", cause);
}

function sameStatGeneration(
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<typeof lstat>>,
) {
  return String(actual.dev) === String(expected.dev)
    && String(actual.ino) === String(expected.ino)
    && actual.nlink === expected.nlink
    && actual.mode === expected.mode
    && actual.uid === expected.uid
    && actual.gid === expected.gid
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && actual.birthtimeMs === expected.birthtimeMs;
}

function sameFileGeneration(expected: FileGeneration | null, actual: FileGeneration | null) {
  return expected === null || actual === null
    ? expected === actual
    : String(actual.dev) === String(expected.dev)
      && String(actual.ino) === String(expected.ino)
      && actual.nlink === expected.nlink
      && actual.mode === expected.mode
      && actual.uid === expected.uid
      && actual.gid === expected.gid
      && actual.size === expected.size
      && actual.mtimeMs === expected.mtimeMs
      && actual.ctimeMs === expected.ctimeMs
      && actual.birthtimeMs === expected.birthtimeMs;
}

function sameFileAcrossRename(expected: FileGeneration, actual: FileGeneration) {
  return String(actual.dev) === String(expected.dev)
    && String(actual.ino) === String(expected.ino)
    && actual.nlink === expected.nlink
    && actual.mode === expected.mode
    && actual.uid === expected.uid
    && actual.gid === expected.gid
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.birthtimeMs === expected.birthtimeMs;
}

const FILE_GENERATION_KEYS = [
  "dev", "ino", "nlink", "mode", "uid", "gid", "size", "mtimeMs", "ctimeMs", "birthtimeMs",
] as const;

function validFileGenerationRecord(value: unknown): value is FileGeneration {
  if (!hasExactKeys(value, FILE_GENERATION_KEYS)) return false;
  const candidate = value as Record<string, unknown>;
  return FILE_GENERATION_KEYS.every((key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]));
}

function sameDirectoryStableObject(expected: FileGeneration, actual: FileGeneration) {
  return String(actual.dev) === String(expected.dev)
    && String(actual.ino) === String(expected.ino)
    && actual.mode === expected.mode
    && actual.uid === expected.uid
    && actual.gid === expected.gid
    && actual.birthtimeMs === expected.birthtimeMs;
}

function sameDirectoryAcrossRename(expected: FileGeneration, actual: FileGeneration) {
  return sameDirectoryStableObject(expected, actual)
    && actual.nlink === expected.nlink
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs;
}

type DirectoryAuthorityEntry = {
  directory: string;
  handle: FileHandle;
  generation: FileGeneration;
  strictGeneration: boolean;
};

type DirectoryAuthority = {
  directory: string;
  entries: DirectoryAuthorityEntry[];
  assert: () => Promise<void>;
  recaptureOwnedMutation: (directory: string) => Promise<void>;
  close: () => Promise<void>;
};

type DirectoryAuthoritySnapshot = {
  directory: string;
  entries: Array<{ directory: string; generation: FileGeneration; strictGeneration: boolean }>;
};

type ActiveFileLockDomain = {
  directory: string;
  authority: DirectoryAuthority;
};

const activeFileLockDomainStorage = new AsyncLocalStorage<ActiveFileLockDomain>();

function absoluteDirectoryChain(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  const chain = [root];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    chain.push(current);
  }
  return chain;
}

async function captureDirectoryAuthoritySnapshot(
  directory: string,
  invalidCode = "EDIRECTORYUNSAFE",
): Promise<DirectoryAuthoritySnapshot> {
  const requested = path.resolve(directory);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (cause) {
    throw Object.assign(new Error(`directory authority path is unavailable: ${requested}`, { cause }), {
      code: invalidCode,
      directory: requested,
    });
  }
  if (canonical !== requested) {
    throw Object.assign(new Error(`directory authority path contains an alias: ${requested}`), {
      code: invalidCode,
      directory: requested,
      expectedDirectory: requested,
      actualDirectory: canonical,
    });
  }
  const chain = absoluteDirectoryChain(canonical);
  const entries: DirectoryAuthoritySnapshot["entries"] = [];
  for (let index = 0; index < chain.length; index += 1) {
    const component = chain[index];
    const current = await lstat(component);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw Object.assign(new Error(`directory authority component is unsafe: ${component}`), {
        code: invalidCode,
        directory: component,
      });
    }
    entries.push({
      directory: component,
      generation: generationFromStat(current),
      strictGeneration: index === chain.length - 1,
    });
  }
  return { directory: canonical, entries };
}

async function openDirectoryAuthorityChain(
  directory: string,
  invalidCode = "EDIRECTORYUNSAFE",
  expectedSnapshot?: DirectoryAuthoritySnapshot,
): Promise<DirectoryAuthority> {
  const requested = path.resolve(directory);
  const activeDomain = activeFileLockDomainStorage.getStore();
  const activeBinding = activeDomain?.directory === requested ? activeDomain : null;
  if (activeBinding) await activeBinding.authority.assert();
  let absolute: string;
  try {
    absolute = await realpath(requested);
  } catch (cause) {
    throw Object.assign(new Error(`directory authority path is unavailable: ${requested}`, { cause }), {
      code: invalidCode,
      directory: requested,
    });
  }
  if (absolute !== requested) {
    throw Object.assign(new Error(`directory authority path contains an alias: ${requested}`), {
      code: invalidCode,
      directory: requested,
      expectedDirectory: requested,
      actualDirectory: absolute,
    });
  }
  if (expectedSnapshot && expectedSnapshot.directory !== absolute) {
    throw Object.assign(new Error(`directory authority canonical binding changed: ${requested}`), {
      code: invalidCode,
      directory: requested,
      expectedDirectory: expectedSnapshot.directory,
      actualDirectory: absolute,
    });
  }
  if (
    typeof fsConstants.O_RDONLY !== "number"
    || typeof fsConstants.O_NOFOLLOW !== "number"
    || fsConstants.O_NOFOLLOW === 0
    || typeof fsConstants.O_DIRECTORY !== "number"
    || fsConstants.O_DIRECTORY === 0
  ) {
    throw Object.assign(new Error(`strict directory authority is unavailable: ${absolute}`), {
      code: invalidCode,
      directory: absolute,
    });
  }

  const entries: DirectoryAuthorityEntry[] = [];
  try {
    const chain = absoluteDirectoryChain(absolute);
    for (let index = 0; index < chain.length; index += 1) {
      const component = chain[index];
      const before = await lstat(component);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw Object.assign(new Error(`directory authority component is unsafe: ${component}`), {
          code: invalidCode,
          directory: component,
        });
      }
      const handle = await open(
        component,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
      );
      const opened = await handle.stat();
      const beforeGeneration = generationFromStat(before);
      const openedGeneration = generationFromStat(opened);
      const generationMatches = index === chain.length - 1
        ? sameFileGeneration(beforeGeneration, openedGeneration)
        : sameDirectoryStableObject(beforeGeneration, openedGeneration);
      const expectedEntry = expectedSnapshot?.entries[index];
      const expectedMatches = !expectedEntry
        || expectedEntry.directory === component
          && (expectedEntry.strictGeneration
            ? sameFileGeneration(expectedEntry.generation, openedGeneration)
            : sameDirectoryStableObject(expectedEntry.generation, openedGeneration));
      const activeExpected = activeBinding && index === chain.length - 1
        ? activeBinding.authority.entries[activeBinding.authority.entries.length - 1].generation
        : null;
      const activeMatches = !activeExpected || sameFileGeneration(activeExpected, openedGeneration);
      if (!opened.isDirectory() || !generationMatches || !expectedMatches || !activeMatches) {
        await handle.close().catch(() => undefined);
        throw Object.assign(new Error(`directory authority changed while opening: ${component}`), {
          code: invalidCode,
          directory: component,
        });
      }
      entries.push({
        directory: component,
        handle,
        generation: generationFromStat(opened),
        strictGeneration: index === chain.length - 1,
      });
    }
  } catch (error) {
    const closeErrors: unknown[] = [];
    for (const entry of entries.reverse()) {
      try { await entry.handle.close(); } catch (closeError) { closeErrors.push(closeError); }
    }
    if (closeErrors.length === 0) throw error;
    throw Object.assign(
      new AggregateError([error, ...closeErrors], `directory authority open and cleanup failed: ${absolute}`, {
        cause: error,
      }),
      { code: invalidCode, directory: absolute },
    );
  }

  async function assertEntry(entry: DirectoryAuthorityEntry) {
    const [descriptor, current] = await Promise.all([
      entry.handle.stat(),
      lstat(entry.directory),
    ]);
    if (
      !descriptor.isDirectory()
      || !current.isDirectory()
      || current.isSymbolicLink()
      || !(entry.strictGeneration
        ? sameFileGeneration(entry.generation, generationFromStat(descriptor))
          && sameFileGeneration(entry.generation, generationFromStat(current))
        : sameDirectoryStableObject(entry.generation, generationFromStat(descriptor))
          && sameDirectoryStableObject(entry.generation, generationFromStat(current)))
    ) {
      throw Object.assign(new Error(`directory authority changed: ${entry.directory}`), {
        code: invalidCode,
        directory: entry.directory,
      });
    }
  }

  async function assertRequestedBinding() {
    let current: string;
    try {
      current = await realpath(requested);
    } catch (cause) {
      throw Object.assign(new Error(`directory authority path became unavailable: ${requested}`, { cause }), {
        code: invalidCode,
        directory: requested,
      });
    }
    if (current !== absolute) {
      throw Object.assign(new Error(`directory authority path was redirected: ${requested}`), {
        code: invalidCode,
        directory: requested,
        expectedDirectory: absolute,
        actualDirectory: current,
      });
    }
  }

  const authority: DirectoryAuthority = {
    directory: absolute,
    entries,
    async assert() {
      await assertRequestedBinding();
      for (const entry of entries) await assertEntry(entry);
    },
    async recaptureOwnedMutation(mutatedDirectory: string) {
      let target: string;
      try {
        target = await realpath(path.resolve(mutatedDirectory));
      } catch (cause) {
        throw Object.assign(new Error(`directory authority path became unavailable during owned mutation: ${requested}`, { cause }), {
          code: invalidCode,
          directory: requested,
        });
      }
      if (target !== absolute) {
        throw Object.assign(new Error(`directory authority path was redirected during owned mutation: ${requested}`), {
          code: invalidCode,
          directory: requested,
          expectedDirectory: absolute,
          actualDirectory: target,
        });
      }
      for (const entry of entries) {
        if (entry.directory !== target) {
          await assertEntry(entry);
          continue;
        }
        const [descriptor, current] = await Promise.all([
          entry.handle.stat(),
          lstat(entry.directory),
        ]);
        const descriptorGeneration = generationFromStat(descriptor);
        const currentGeneration = generationFromStat(current);
        if (
          !descriptor.isDirectory()
          || !current.isDirectory()
          || current.isSymbolicLink()
          || !sameDirectoryStableObject(entry.generation, descriptorGeneration)
          || !sameFileGeneration(descriptorGeneration, currentGeneration)
        ) {
          throw Object.assign(new Error(`directory authority changed during owned mutation: ${entry.directory}`), {
            code: invalidCode,
            directory: entry.directory,
          });
        }
        entry.generation = currentGeneration;
      }
    },
    async close() {
      const closeErrors: unknown[] = [];
      for (const entry of [...entries].reverse()) {
        try { await entry.handle.close(); } catch (error) { closeErrors.push(error); }
      }
      if (closeErrors.length > 0) {
        throw Object.assign(new AggregateError(closeErrors, `directory authority close failed: ${absolute}`), {
          code: invalidCode,
          directory: absolute,
        });
      }
    },
  };
  try {
    await authority.assert();
    return authority;
  } catch (error) {
    try { await authority.close(); } catch (closeError) {
      throw Object.assign(
        new AggregateError([error, closeError], `directory authority validation and close failed: ${absolute}`, {
          cause: error,
        }),
        { code: invalidCode, directory: absolute },
      );
    }
    throw error;
  }
}

async function readBoundedNoFollowFileSnapshot(
  file: string,
  {
    maxBytes,
    kind,
    invalidCode,
    afterLstat,
  }: {
    maxBytes: number;
    kind: string;
    invalidCode: string;
    afterLstat?: () => void | Promise<void>;
  },
) {
  const parent = path.dirname(file);
  const parentAuthority = await openDirectoryAuthorityChain(parent, invalidCode);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    await parentAuthority.assert();
    before = await lstat(file);
    if (!safeRegularFile(before)) {
      throw invalidFileRead(`${kind} is not a regular file: ${file}`, invalidCode);
    }
    if (before.size > maxBytes) {
      throw invalidFileRead(`${kind} exceeds ${maxBytes} bytes: ${file}`, invalidCode);
    }
    await afterLstat?.();
    await parentAuthority.assert();
  } catch (error) {
    try { await parentAuthority.close(); } catch (closeError) {
      throw Object.assign(
        new AggregateError([error, closeError], `${kind} setup and authority close failed: ${file}`, { cause: error }),
        { code: invalidCode },
      );
    }
    throw error;
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw invalidFileRead(`${kind} no-follow open is unavailable: ${file}`, invalidCode);
    }
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    try { await parentAuthority.close(); } catch (closeError) {
      throw Object.assign(
        new AggregateError([error, closeError], `${kind} open and authority close failed: ${file}`, { cause: error }),
        { code: invalidCode },
      );
    }
    if (errorCode(error) === "ELOOP" || errorCode(error) === "EMLINK") {
      throw invalidFileRead(`${kind} became a symlink: ${file}`, invalidCode, error);
    }
    throw error;
  }

  let primaryError: unknown = null;
  let raw = "";
  try {
    const opened = await handle.stat();
    if (!safeRegularFile(opened) || !sameStatGeneration(before, opened) || opened.size > maxBytes) {
      throw invalidFileRead(`${kind} changed while opening: ${file}`, invalidCode);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) {
        throw invalidFileRead(`${kind} exceeds ${maxBytes} bytes: ${file}`, invalidCode);
      }
      const chunk = Buffer.allocUnsafe(Math.min(4 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw invalidFileRead(`${kind} exceeds ${maxBytes} bytes: ${file}`, invalidCode);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const afterRead = await handle.stat();
    let afterPath: Awaited<ReturnType<typeof lstat>>;
    try {
      afterPath = await lstat(file);
    } catch (error) {
      throw invalidFileRead(`${kind} path changed while reading: ${file}`, invalidCode, error);
    }
    if (
      total !== opened.size
      || !safeRegularFile(afterRead)
      || !safeRegularFile(afterPath)
      || !sameStatGeneration(opened, afterRead)
      || !sameStatGeneration(opened, afterPath)
    ) {
      throw invalidFileRead(`${kind} changed while reading: ${file}`, invalidCode);
    }
    try {
      await parentAuthority.assert();
    } catch (cause) {
      throw invalidFileRead(`${kind} parent directory changed while reading: ${parent}`, invalidCode, cause);
    }
    raw = Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  try {
    await parentAuthority.close();
  } catch (error) {
    closeError = closeError
      ? new AggregateError([closeError, error], `${kind} file and authority close failed: ${file}`, { cause: closeError })
      : error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `${kind} read and close failed: ${file}`, {
        cause: primaryError,
      }),
      { code: invalidCode },
    );
  }
  if (closeError) throw closeError;
  return { raw, generation: generationFromStat(before) };
}

async function readBoundedNoFollowFile(
  file: string,
  options: Parameters<typeof readBoundedNoFollowFileSnapshot>[1],
) {
  return (await readBoundedNoFollowFileSnapshot(file, options)).raw;
}

async function readLockMetadataFile(metadataFile: string) {
  return await readBoundedNoFollowFile(metadataFile, {
    maxBytes: LOCK_METADATA_MAX_BYTES,
    kind: "file lock metadata",
    invalidCode: "ELOCKINVALID",
    afterLstat: async () => {
      await infraLockTestHooks().afterLockMetadataLstat?.({ metadataFile });
    },
  });
}

async function inspectLockOwner(lockDir: string, file: string) {
  let lockStat;
  try {
    lockStat = await lstat(lockDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (lockStat.isSymbolicLink()) {
    throw Object.assign(new Error(`file lock is a symlink: ${lockDir}`), { code: "ELOCKSYMLINK" });
  }
  if (!lockStat.isDirectory()) {
    throw Object.assign(new Error(`file lock is not a directory: ${lockDir}`), { code: "ELOCKINVALID" });
  }
  const metadataFile = path.join(lockDir, "lock.json");
  let metadata: LooseRecord;
  try {
    metadata = recordValue(JSON.parse(await readLockMetadataFile(metadataFile)));
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") throw cause;
    if (errorCode(cause) === "ELOCKINVALID") throw cause;
    throw invalidLockMetadata(`file lock metadata is corrupt: ${metadataFile}`, cause);
  }
  let finalLockStat: Awaited<ReturnType<typeof lstat>>;
  try {
    finalLockStat = await lstat(lockDir);
  } catch (error) {
    throw invalidLockMetadata(`file lock path changed while reading owner: ${lockDir}`, error);
  }
  if (!finalLockStat.isDirectory() || finalLockStat.isSymbolicLink() || !sameStatGeneration(lockStat, finalLockStat)) {
    throw invalidLockMetadata(`file lock generation changed while reading owner: ${lockDir}`);
  }
  const ownerPid = metadata.ownerPid;
  const ownerIdentity = registeredProcessIdentity(metadata.ownerIdentity, typeof ownerPid === "number" ? ownerPid : undefined);
  if (
    !hasExactKeys(metadata, [
      "version",
      "acquiredAt",
      "ownerPid",
      "ownerHost",
      "ownerToken",
      "ownerIdentity",
      "targetGeneration",
    ])
    || metadata.version !== 1
    || !validCanonicalTimestamp(metadata.acquiredAt)
    || typeof ownerPid !== "number"
    || !Number.isSafeInteger(ownerPid)
    || ownerPid <= 0
    || typeof metadata.ownerToken !== "string"
    || metadata.ownerToken.length === 0
    || typeof metadata.ownerHost !== "string"
    || metadata.ownerHost.length === 0
    || !ownerIdentity
    || !(metadata.targetGeneration === null || validFileGenerationRecord(metadata.targetGeneration))
  ) {
    throw Object.assign(new Error(`invalid file lock metadata: ${metadataFile}`), { code: "ELOCKINVALID" });
  }
  return {
    ownerToken: metadata.ownerToken as string,
    ownerHost: metadata.ownerHost as string,
    ownerIdentity,
    targetGeneration: metadata.targetGeneration ?? null,
    lockGeneration: generationFromStat(lockStat),
    currentTargetGeneration: await fileGeneration(file),
  };
}

function isLocalLockOwnerDead(owner: { ownerHost: string; ownerIdentity: ProcessIdentity }) {
  if (owner.ownerHost !== hostname()) return false;
  try {
    process.kill(owner.ownerIdentity.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return true;
    throw error;
  }
  let current: ProcessIdentity | null;
  try {
    current = captureExactProcessIdentity(owner.ownerIdentity.pid);
  } catch (cause) {
    throw Object.assign(new Error(`file lock owner identity could not be recaptured: ${owner.ownerIdentity.pid}`, { cause }), {
      code: "ELOCKIDENTITY",
    });
  }
  if (current) return !sameProcessIdentity(owner.ownerIdentity, current);
  try {
    process.kill(owner.ownerIdentity.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return true;
    throw error;
  }
  throw Object.assign(new Error(`file lock owner identity is unavailable: ${owner.ownerIdentity.pid}`), {
    code: "ELOCKIDENTITY",
  });
}

function exactProcessIdentity(identity: ProcessIdentity | null): ProcessIdentity | null {
  if (!identity) return null;
  return registeredProcessIdentity(identity, identity.pid);
}

function captureExactProcessIdentity(pid: number, processSystem?: ProcessTreeSystem) {
  const captureForTest = infraLockTestHooks().captureProcessIdentity;
  return exactProcessIdentity(captureForTest
    ? captureForTest(pid, processSystem)
    : captureProcessIdentity(pid, {
      strict: true,
      ...(processSystem ? { system: processSystem } : {}),
    }));
}

function requireLeaseOwnerIdentity(ownerPid: number, context: string) {
  let ownerIdentity: ProcessIdentity | null = null;
  let cause: unknown = null;
  try {
    ownerIdentity = captureExactProcessIdentity(ownerPid);
  } catch (error) {
    cause = error;
  }
  if (!ownerIdentity) {
    throw Object.assign(new Error(`${context} owner process identity unavailable`), {
      code: "PROCESS_IDENTITY_UNAVAILABLE",
      ownerPid,
      context,
      cause,
    });
  }
  return ownerIdentity;
}

async function writeLockMetadata(lockDir: string, file: string, ownerToken: string) {
  const ownerIdentity = captureExactProcessIdentity(process.pid);
  if (!ownerIdentity) {
    throw Object.assign(new Error("current process identity unavailable for file lock"), {
      code: "PROCESS_IDENTITY_UNAVAILABLE",
      ownerPid: process.pid,
      context: "lease file lock acquisition",
    });
  }
  await atomicWriteJson(path.join(lockDir, "lock.json"), {
    version: 1,
    acquiredAt: new Date().toISOString(),
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken,
    ownerIdentity,
    targetGeneration: await fileGeneration(file),
  }, null);
}

async function existingLockRecoveryPaths(
  lockDir: string,
  quarantineDir: string,
  expectedQuarantineGeneration: FileGeneration | null,
) {
  const recoveryPaths: { canonical?: string; quarantine?: string } = {};
  try {
    const canonical = await lstat(lockDir);
    if (canonical.isDirectory() && !canonical.isSymbolicLink()) recoveryPaths.canonical = lockDir;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    const quarantine = await lstat(quarantineDir);
    if (
      expectedQuarantineGeneration
      && quarantine.isDirectory()
      && !quarantine.isSymbolicLink()
      && sameFileGeneration(expectedQuarantineGeneration, generationFromStat(quarantine))
    ) {
      recoveryPaths.quarantine = quarantineDir;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return recoveryPaths;
}

async function isolateLockDirectory(
  lockDir: string,
  file: string,
  {
    expectedGeneration,
    expectedOwnerToken,
    kind,
    invokeHook = true,
  }: {
    expectedGeneration: FileGeneration;
    expectedOwnerToken?: string;
    kind: "dead" | "released" | "incomplete";
    invokeHook?: boolean;
  },
) {
  const parent = path.dirname(lockDir);
  const parentAuthority = await openDirectoryAuthorityChain(parent, "ELOCKPARENT");
  const quarantineDir = `${lockDir}.${kind}.${process.pid}.${randomUUID()}`;
  let renamed = false;
  let quarantineGeneration: FileGeneration | null = null;
  let primaryError: unknown = null;
  try {
    await parentAuthority.assert();
    await parentAuthority.entries[parentAuthority.entries.length - 1].handle.sync();
    await parentAuthority.assert();
    const preRename = await lstat(lockDir);
    const preRenameGeneration = generationFromStat(preRename);
    if (
      !preRename.isDirectory()
      || preRename.isSymbolicLink()
      || !sameFileGeneration(expectedGeneration, preRenameGeneration)
    ) {
      throw Object.assign(new Error(`file lock successor preserved before ${kind} isolation: ${lockDir}`), {
        code: "ELOCKOWNER",
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: lockDir },
      });
    }
    await rename(lockDir, quarantineDir);
    renamed = true;
    await parentAuthority.recaptureOwnedMutation(parent);
    const quarantinedStat = await lstat(quarantineDir);
    if (
      !quarantinedStat.isDirectory()
      || quarantinedStat.isSymbolicLink()
      || !sameDirectoryAcrossRename(preRenameGeneration, generationFromStat(quarantinedStat))
    ) {
      throw Object.assign(new Error(`file lock changed during ${kind} isolation: ${quarantineDir}`), {
        code: "ELOCKOWNER",
      });
    }
    quarantineGeneration = generationFromStat(quarantinedStat);
    if (kind === "dead" && durabilityFaultEnabled("after-lock-remove", file)) {
      throw injectedDurabilityFault("after-lock-remove", file);
    }
    await parentAuthority.entries[parentAuthority.entries.length - 1].handle.sync();
    await parentAuthority.assert();
    if (invokeHook) {
      await infraLockTestHooks().afterQuarantineRename?.({ lockDir, quarantineDir });
    }
    if (expectedOwnerToken !== undefined) {
      const quarantined = await inspectLockOwner(quarantineDir, file);
      if (
        !quarantined
        || quarantined.ownerToken !== expectedOwnerToken
        || !sameFileGeneration(quarantineGeneration, quarantined.lockGeneration)
      ) {
        throw Object.assign(new Error(`file lock owner changed during ${kind} isolation`), { code: "ELOCKOWNER" });
      }
    }
    try {
      await lstat(lockDir);
      throw Object.assign(new Error(`file lock successor preserved during ${kind} isolation: ${lockDir}`), {
        code: "ELOCKOWNER",
        successorPreserved: true,
      });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await parentAuthority.assert();
    const final = await lstat(quarantineDir);
    if (
      !final.isDirectory()
      || final.isSymbolicLink()
      || !sameFileGeneration(quarantineGeneration, generationFromStat(final))
    ) {
      throw Object.assign(new Error(`file lock quarantine changed after ${kind} isolation: ${quarantineDir}`), {
        code: "ELOCKOWNER",
      });
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await parentAuthority.close();
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError([primaryError, error], `file lock isolation and authority close failed: ${lockDir}`, { cause: primaryError })
      : error;
  }
  if (primaryError) {
    if (!renamed) throw primaryError;
    const recoveryPaths = await existingLockRecoveryPaths(lockDir, quarantineDir, quarantineGeneration);
    const successorPreserved = Boolean(recoveryPaths.canonical);
    const quarantinePreserved = Boolean(recoveryPaths.quarantine);
    const durabilityAmbiguous = errorCode(primaryError) === "EINJECTED_DURABILITY_FAULT";
    throw Object.assign(
      new AggregateError([primaryError], successorPreserved
        ? `file lock successor and quarantined predecessor preserved: ${lockDir}`
        : `file lock quarantine preserved after ${kind} isolation failure: ${quarantineDir}`, {
        cause: primaryError,
      }),
      {
        code: durabilityAmbiguous
          ? "DURABLE_LOCK_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS"
          : successorPreserved ? "ELOCKOWNER" : quarantinePreserved ? "ELOCKRESTORE" : "ELOCKLINEAGELOST",
        committed: true,
        committedPath: recoveryPaths.quarantine ?? null,
        lockDir,
        quarantine: quarantineDir,
        quarantinePreserved,
        successorPreserved,
        lineageLost: !quarantinePreserved,
        recoveryPaths,
      },
    );
  }
  return {
    committed: true,
    committedPath: quarantineGeneration ? quarantineDir : null,
    quarantinePreserved: true,
    lineageLost: false,
    recoveryPaths: { quarantine: quarantineDir },
  };
}

async function recoverDeadLocalLock(lockDir: string, file: string, incompleteCutoffMs: number) {
  let current: Awaited<ReturnType<typeof inspectLockOwner>>;
  try {
    current = await inspectLockOwner(lockDir, file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    let incomplete: Awaited<ReturnType<typeof lstat>>;
    try {
      incomplete = await lstat(lockDir);
    } catch (candidateError) {
      if (errorCode(candidateError) === "ENOENT") return true;
      throw candidateError;
    }
    if (!incomplete.isDirectory() || incomplete.isSymbolicLink()) {
      throw Object.assign(new Error(`incomplete file lock is unsafe: ${lockDir}`), { code: "ELOCKINVALID" });
    }
    if (!Number.isFinite(incomplete.mtimeMs) || incomplete.mtimeMs > incompleteCutoffMs) return false;
    await isolateLockDirectory(lockDir, file, {
      expectedGeneration: generationFromStat(incomplete),
      kind: "incomplete",
    });
    return true;
  }
  if (!current || !isLocalLockOwnerDead(current)) return false;
  await isolateLockDirectory(lockDir, file, {
    expectedGeneration: current.lockGeneration,
    expectedOwnerToken: current.ownerToken,
    kind: "dead",
  });
  return true;
}

async function removeOwnedLock(lockDir: string, file: string, ownerToken: string, expectedLockGeneration: FileGeneration | null) {
  const current = await inspectLockOwner(lockDir, file);
  if (!current) return null;
  if (
    expectedLockGeneration === null
    || current.ownerToken !== ownerToken
    || !sameFileGeneration(expectedLockGeneration, current.lockGeneration)
  ) {
    throw Object.assign(new Error("file lock owner changed; successor preserved"), {
      code: "ELOCKOWNER",
      committed: false,
      successorPreserved: true,
      recoveryPaths: { canonical: lockDir },
    });
  }
  return await isolateLockDirectory(lockDir, file, {
    expectedGeneration: expectedLockGeneration,
    expectedOwnerToken: ownerToken,
    kind: "released",
  });
}

type AcquiredFileLock = {
  canonicalFile: string;
  run: <T>(callback: () => Promise<T>) => Promise<T>;
  release: () => Promise<void>;
};

async function acquireLeaseFileLock(file: string, { purpose = "lease", lockTtlMs }: FileLockOptions = {}): Promise<AcquiredFileLock> {
  const effectiveLockTtlMs = lockTtlMsFor(lockTtlMs);
  const ownerToken = randomUUID();

  const requestedFile = path.resolve(file);
  const requestedParent = path.dirname(requestedFile);
  const expectedAuthority = await captureDirectoryAuthoritySnapshot(requestedParent, "ELOCKPARENT");
  const canonicalParent = expectedAuthority.directory;
  const canonicalFile = path.join(canonicalParent, path.basename(file));
  if (canonicalFile !== requestedFile) {
    throw Object.assign(new Error(`file lock target contains an alias: ${requestedFile}`), {
      code: "ELOCKPARENT",
      requestedFile,
      canonicalFile,
    });
  }
  const lockDir = `${canonicalFile}.lock`;
  const lockParent = path.dirname(lockDir);
  let lockParentAuthority: DirectoryAuthority | null = null;
  let releaseFence: (() => Promise<void>) | null = null;
  let acquired = false;
  let acquiredLockGeneration: FileGeneration | null = null;

  try {
    await infraLockTestHooks().afterCanonicalFenceResolutionBeforeAuthorityOpen?.({
      requestedFile,
      canonicalFile,
      requestedParent,
      canonicalParent,
    });
    const authority = await openDirectoryAuthorityChain(lockParent, "ELOCKPARENT", expectedAuthority);
    lockParentAuthority = authority;
    await authority.assert();
    releaseFence = await acquireOsProcessFence(canonicalFile, { purpose, lockTtlMs: effectiveLockTtlMs });
    // Another owner of this exact file may have legitimately mutated sibling
    // directory entries while this contender waited for the process fence.
    // Rebind only the same pinned directory object; aliases or replacements
    // still fail the stable-object proof inside recaptureOwnedMutation.
    await authority.recaptureOwnedMutation(lockParent);
    const acquisitionStartedAt = Date.now();
    const deadline = acquisitionStartedAt + effectiveLockTtlMs;
    const incompleteCutoffMs = acquisitionStartedAt - effectiveLockTtlMs;
    for (;;) {
      let createdGeneration: FileGeneration | null = null;
      try {
        await authority.assert();
        await mkdir(lockDir);
        await authority.recaptureOwnedMutation(lockParent);
        const created = await lstat(lockDir);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw Object.assign(new Error(`file lock creation produced an unsafe directory: ${lockDir}`), {
            code: "ELOCKINVALID",
          });
        }
        createdGeneration = generationFromStat(created);
        await writeLockMetadata(lockDir, canonicalFile, ownerToken);
        const owner = await inspectLockOwner(lockDir, canonicalFile);
        if (
          !owner
          || owner.ownerToken !== ownerToken
          || !sameDirectoryStableObject(createdGeneration, owner.lockGeneration)
        ) {
          throw Object.assign(new Error("file lock owner changed during acquisition"), { code: "ELOCKOWNER" });
        }
        acquiredLockGeneration = owner.lockGeneration;
        try {
          await authority.entries[authority.entries.length - 1].handle.sync();
          await authority.assert();
        } catch (cause) {
          throw Object.assign(new Error(`file lock acquisition committed with ambiguous parent durability: ${lockDir}`, { cause }), {
            code: "DURABLE_LOCK_ACQUIRE_COMMITTED_DURABILITY_AMBIGUOUS",
            committed: true,
            committedPath: lockDir,
            recoveryPaths: { canonical: lockDir },
          });
        }
          const finalOwner = await inspectLockOwner(lockDir, canonicalFile);
        await authority.assert();
        if (
          !finalOwner
          || finalOwner.ownerToken !== ownerToken
          || !sameFileGeneration(owner.lockGeneration, finalOwner.lockGeneration)
        ) {
          throw Object.assign(new Error("file lock owner changed after acquisition durability sync"), {
            code: "ELOCKOWNER",
            committed: true,
            committedPath: lockDir,
            successorPreserved: true,
            recoveryPaths: { canonical: lockDir },
          });
        }
        acquiredLockGeneration = finalOwner.lockGeneration;
        acquired = true;
        break;
      } catch (err) {
        if (errorCode(err) === "EEXIST") {
          if (await recoverDeadLocalLock(lockDir, canonicalFile, incompleteCutoffMs)) {
            await authority.recaptureOwnedMutation(lockParent);
            continue;
          }
          if (Date.now() >= deadline) {
            throw Object.assign(new Error(`lease lock busy: ${path.basename(file)}`), { code: "ELOCKBUSY" });
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (createdGeneration) {
          let cleanupResult: Awaited<ReturnType<typeof isolateLockDirectory>> | null = null;
          let cleanupError: unknown = null;
          try {
            const current = await lstat(lockDir);
            const currentGeneration = generationFromStat(current);
            if (
              !current.isDirectory()
              || current.isSymbolicLink()
              || !sameDirectoryStableObject(createdGeneration, currentGeneration)
            ) {
              throw Object.assign(new Error("created file lock was replaced before failed acquisition cleanup"), {
                code: "ELOCKOWNER",
                successorPreserved: true,
              });
            }
            let verifiedOwnerToken: string | undefined;
            try {
              const owner = await inspectLockOwner(lockDir, canonicalFile);
              if (owner?.ownerToken === ownerToken) verifiedOwnerToken = ownerToken;
            } catch {}
            cleanupResult = await isolateLockDirectory(lockDir, canonicalFile, {
              expectedGeneration: currentGeneration,
              ...(verifiedOwnerToken ? { expectedOwnerToken: verifiedOwnerToken } : {}),
              kind: "incomplete",
              invokeHook: false,
            });
          } catch (error) {
            cleanupError = error;
          }
          try {
            if (cleanupResult || (cleanupError && typeof cleanupError === "object" && (cleanupError as { committed?: unknown }).committed === true)) {
              await authority.recaptureOwnedMutation(lockParent);
            } else {
              await authority.assert();
            }
          } catch (error) {
            cleanupError = cleanupError
              ? new AggregateError([cleanupError, error], "failed lock cleanup and parent recapture failed", { cause: cleanupError })
              : error;
          }
          if (cleanupError) {
            throw Object.assign(
              new AggregateError([err, cleanupError], `file lock acquisition failed and exact cleanup was incomplete: ${lockDir}`, {
                cause: err,
              }),
              {
                code: errorCode(err) || "ELOCKINVALID",
                committed: Boolean((err as { committed?: unknown })?.committed),
                primaryError: err,
                cleanupError,
              },
            );
          }
          if (err && typeof err === "object") {
            const publicationRecoveryPaths = (err as { recoveryPaths?: unknown }).recoveryPaths;
            Object.assign(err, {
              lockCleanupCommitted: true,
              lockCleanupPath: cleanupResult?.committedPath ?? null,
              lockRecoveryPaths: cleanupResult?.recoveryPaths ?? {},
              publicationRecoveryPaths,
              committedPath: cleanupResult?.committedPath ?? null,
              recoveryPaths: cleanupResult?.recoveryPaths ?? {},
              canonicalLockRetained: false,
            });
          }
        }
        throw err;
      }
    }

    const domain: ActiveFileLockDomain = { directory: lockParent, authority };
    return {
      canonicalFile,
      async run<T>(callback: () => Promise<T>) {
        return await activeFileLockDomainStorage.run(domain, async () => {
          let callbackError: unknown = null;
          let value: T | undefined;
          try {
            value = await callback();
          } catch (error) {
            callbackError = error;
          }
          let recaptureError: unknown = null;
          try {
            await authority.recaptureOwnedMutation(lockParent);
          } catch (error) {
            recaptureError = error;
          }
          if (callbackError || recaptureError) {
            throw combineFileLockErrors("file lock callback authority changed", [callbackError, recaptureError]);
          }
          return value as T;
        });
      },
      async release() {
      let releaseError: unknown = null;
      let releaseResult: Awaited<ReturnType<typeof removeOwnedLock>> = null;
      try {
        releaseResult = await removeOwnedLock(lockDir, canonicalFile, ownerToken, acquiredLockGeneration);
      } catch (error) {
        releaseError = error;
      }
      try {
        if (releaseResult || (releaseError && typeof releaseError === "object" && (releaseError as { committed?: unknown }).committed === true)) {
          await authority.recaptureOwnedMutation(lockParent);
        } else {
          await authority.assert();
        }
      } catch (error) {
        releaseError = releaseError
          ? new AggregateError([releaseError, error], "file lock removal and authority recapture failed", { cause: releaseError })
          : error;
      }
      let fenceError: unknown = null;
      try {
        await infraLockTestHooks().beforeProcessFenceRelease?.({ canonicalFile, lockDir, acquired: true });
        await releaseFence?.();
      } catch (error) {
        fenceError = error;
      }
      let authorityError: unknown = null;
      try {
        await authority.close();
      } catch (error) {
        authorityError = error;
      }
      if (releaseError || fenceError || authorityError) {
        throw combineFileLockErrors("file lock release failed", [releaseError, fenceError, authorityError]);
      }
      },
    };
  } catch (error) {
    let fenceError: unknown = null;
    if (!acquired) {
      try {
        if (releaseFence) {
          await infraLockTestHooks().beforeProcessFenceRelease?.({ canonicalFile, lockDir, acquired: false });
        }
        await releaseFence?.();
      } catch (releaseError) {
        fenceError = releaseError;
      }
    }
    let authorityError: unknown = null;
    try {
      await lockParentAuthority?.close();
    } catch (closeError) {
      authorityError = closeError;
    }
    if (!fenceError && !authorityError) throw error;
    throw combineFileLockErrors("file lock acquisition cleanup failed", [error, fenceError, authorityError]);
  }
}

async function withLeaseLock<T>(file: string, callback: () => Promise<T>, { lockTtlMs }: LeaseLockOptions = {}): Promise<T> {
  const lock = await acquireLeaseFileLock(file, { lockTtlMs });
  let primaryError: unknown = null;
  try {
    return await lock.run(callback);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      if (primaryError) throw combineFileLockErrors("lease operation and lock release failed", [primaryError, releaseError]);
      throw releaseError;
    }
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
  const ownerIdentity = requireLeaseOwnerIdentity(ownerPid, "local lease acquisition");
  return {
    formatVersion: LEASE_FORMAT_VERSION,
    leaseId,
    jobId,
    phase,
    ownerPid,
    ownerHost: hostname(),
    ownerToken,
    ownerIdentity,
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
  validateLeaseId(leaseId);
  if (!nonEmptyString(jobId) || !nonEmptyString(phase)) {
    throw Object.assign(new Error("lease jobId and phase must be non-empty strings"), { code: "ELEASEINVALID" });
  }
  const effectiveOwnerPid = positiveSafePid(ownerPid, "ownerPid");
  const effectiveTtlMs = leaseTtlMsFor(ttlMs);
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
      const ownerIdentity = requireLeaseOwnerIdentity(effectiveOwnerPid, "Redis lease acquisition");
      const lease: LeaseRecord = {
        formatVersion: LEASE_FORMAT_VERSION,
        leaseId, jobId, phase, ownerPid: effectiveOwnerPid, ownerHost: hostname(), ownerToken,
        ownerIdentity,
        acquiredAt: timestamp, heartbeatAt: timestamp,
        expiresAtMs: nowMs + effectiveTtlMs,
        expiresAt: new Date(nowMs + effectiveTtlMs).toISOString(),
      };
      const committed = await redis.compareAndSwapStateRecord(field, snapshot.revision, lease);
      if (committed.committed) {
        return lease;
      }
    }
    throw Object.assign(new Error(`lease changed too frequently: ${leaseId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }
  const file = await leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
  return await withLeaseLock(file, async () => {
    const lease = createLease({
      leaseId,
      jobId,
      phase,
      ttlMs: effectiveTtlMs,
      now,
      ownerPid: effectiveOwnerPid,
    });
    const existingSnapshot = await readLeaseFileSnapshot(file);
    const existing = existingSnapshot?.lease ?? null;
    if (existing !== null && !isLeaseStale(existing, now)) {
      const err = Object.assign(new Error(`lease already exists: ${leaseId}`), { code: "EEXIST" });
      throw err;
    }

    await atomicWriteJson(file, lease, existingSnapshot?.generation ?? null);
    return lease;
  }, { lockTtlMs });
}

export async function readLease(
  cpbRoot: string,
  leaseId: string,
  { dataRoot, includeLegacyFallback = false, lockTtlMs }: RuntimeStorageOptions & LeaseLockOptions = {},
) {
  const redis = await redisLeaseBackend();
  if (redis) {
    await assertNoLocalLeaseState(cpbRoot, { dataRoot, includeLegacyFallback });
    return parseRedisLease((await redis.readStateRecord(redisLeaseField(leaseId))).data, leaseId);
  }
  const file = await leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
  return await withLeaseLock(file, async () => readLeaseFile(file), { lockTtlMs });
}

export function isLeaseStale(lease: LooseRecord | null, now = new Date()) {
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
  const effectiveTtlMs = leaseTtlMsFor(ttlMs);
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
        formatVersion: LEASE_FORMAT_VERSION,
        leaseId: existing.leaseId,
        jobId: existing.jobId,
        phase: existing.phase,
        ownerPid: existing.ownerPid,
        ownerHost: existing.ownerHost,
        ownerToken: existing.ownerToken,
        ownerIdentity: existing.ownerIdentity,
        acquiredAt: existing.acquiredAt,
        heartbeatAt: new Date(nowMs).toISOString(),
        expiresAtMs: nowMs + effectiveTtlMs,
        expiresAt: new Date(nowMs + effectiveTtlMs).toISOString(),
      };
      const committed = await redis.compareAndSwapStateRecord(field, snapshot.revision, renewed);
      if (committed.committed) {
        return renewed;
      }
    }
    throw Object.assign(new Error(`lease changed too frequently: ${leaseId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }
  const file = await leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
  return await withLeaseLock(
    file,
    async () => {
      const existingSnapshot = await readLeaseFileSnapshot(file);
      const existing = existingSnapshot?.lease ?? null;
      if (existing === null || !existingSnapshot) {
        throw new Error(`lease not found: ${leaseId}`);
      }

      const effectiveOwnerToken = leaseOwnerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);
      if (isLeaseStale(existing, now)) {
        throw Object.assign(new Error(`lease expired: ${leaseId}`), { code: "ESTALE" });
      }

      const renewed: LeaseRecord = {
        formatVersion: LEASE_FORMAT_VERSION,
        leaseId: existing.leaseId,
        jobId: existing.jobId,
        phase: existing.phase,
        ownerPid: existing.ownerPid,
        ownerHost: existing.ownerHost,
        ownerToken: existing.ownerToken,
        ownerIdentity: existing.ownerIdentity,
        acquiredAt: existing.acquiredAt,
        heartbeatAt: now.toISOString(),
        expiresAt: expiresAtFor(now, effectiveTtlMs),
        ...(existing.expiresAtMs === undefined
          ? {}
          : { expiresAtMs: now.getTime() + effectiveTtlMs }),
      };

      await atomicWriteJson(file, renewed, existingSnapshot.generation);
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
        return;
      }
    }
    throw Object.assign(new Error(`lease changed too frequently: ${leaseId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }
  const file = await leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });

  const lock = await acquireLeaseFileLock(file, { lockTtlMs });
  let primaryError: unknown = null;
  try {
    await lock.run(async () => {
      const existingSnapshot = await readLeaseFileSnapshot(file);
      const existing = existingSnapshot?.lease ?? null;
      if (existing === null || !existingSnapshot) return;

      const effectiveOwnerToken = leaseOwnerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      await removePathDurably(file, {
        force: false,
        faultPoint: "after-lease-remove",
        ambiguityCode: "DURABLE_LEASE_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
        expectedGeneration: existingSnapshot.generation,
      });
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      if (primaryError) throw combineFileLockErrors("lease release operation and lock release failed", [primaryError, releaseError]);
      throw releaseError;
    }
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

function processBase(cpbRoot: string, { dataRoot, includeLegacyFallback = false }: RuntimeStorageOptions = {}) {
  if (dataRoot) return path.resolve(dataRoot);
  if (includeLegacyFallback === true) return path.join(path.resolve(cpbRoot), "cpb-task");
  throw new Error("project runtime root required for process registry");
}

async function processDir(cpbRoot: string, options: RuntimeStorageOptions = {}) {
  return await prepareStorageDirectory(
    cpbRoot,
    processBase(cpbRoot, options),
    "processes",
    "EPROCESSREGISTRYINVALID",
  );
}

async function processFile(cpbRoot: string, jobId: string, options: RuntimeStorageOptions = {}) {
  validateId(jobId, "jobId");
  return path.join(await processDir(cpbRoot, options), `${jobId}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

const PROCESS_REGISTRY_STATUSES = new Set(["running", "exited", "stopped", "orphan"]);
const PROCESS_ENTRY_REQUIRED_KEYS = [
  "formatVersion",
  "jobId",
  "project",
  "phase",
  "runnerPid",
  "processIdentity",
  "treeId",
  "childPids",
  "childIdentities",
  "leaseId",
  "startedAt",
  "lastHeartbeat",
  "status",
  "exitCode",
  "command",
  "cwd",
  "executorRoot",
] as const;
const PROCESS_SESSION_PIN_KEYS = ["sessionId", "phase", "agentPid", "pinnedAt"] as const;

function nullableString(value: unknown) {
  return value === null || nonEmptyString(value);
}

function validPersistentProcessEntry(entry: ProcessEntry, expectedJobId: string) {
  const runnerPid = entry.runnerPid;
  if (
    !hasExactKeys(entry, PROCESS_ENTRY_REQUIRED_KEYS, ["sessionPin"])
    || entry.formatVersion !== PROCESS_REGISTRY_FORMAT_VERSION
    || entry.jobId !== expectedJobId
    || typeof runnerPid !== "number"
    || !Number.isSafeInteger(runnerPid)
    || runnerPid <= 0
    || !registeredProcessIdentity(entry.processIdentity, runnerPid)
    || !nullableString(entry.project)
    || !nullableString(entry.phase)
    || !nullableString(entry.treeId)
    || !nullableString(entry.leaseId)
    || !nullableString(entry.command)
    || !nullableString(entry.cwd)
    || !nullableString(entry.executorRoot)
    || !validCanonicalTimestamp(entry.startedAt)
    || !validCanonicalTimestamp(entry.lastHeartbeat)
    || typeof entry.status !== "string"
    || !PROCESS_REGISTRY_STATUSES.has(entry.status)
    || !(entry.exitCode === null || Number.isSafeInteger(entry.exitCode))
    || !Array.isArray(entry.childPids)
    || !Array.isArray(entry.childIdentities)
  ) return false;

  if (
    (entry.status === "running" || entry.status === "orphan") && entry.exitCode !== null
    || entry.childPids.length !== entry.childIdentities.length
  ) return false;

  const seen = new Set<number>();
  for (let index = 0; index < entry.childPids.length; index += 1) {
    const childPid = entry.childPids[index];
    if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0 || seen.has(childPid)) return false;
    const childIdentity = registeredProcessIdentity(entry.childIdentities[index], childPid);
    if (!childIdentity) return false;
    seen.add(childPid);
  }

  if (entry.sessionPin !== undefined) {
    const sessionPin = recordValue(entry.sessionPin);
    if (
      !hasExactKeys(sessionPin, PROCESS_SESSION_PIN_KEYS)
      || !nonEmptyString(sessionPin.sessionId)
      || !nonEmptyString(sessionPin.phase)
      || typeof sessionPin.agentPid !== "number"
      || !Number.isSafeInteger(sessionPin.agentPid)
      || sessionPin.agentPid <= 0
      || !validCanonicalTimestamp(sessionPin.pinnedAt)
    ) return false;
  }
  return true;
}

function parseProcessEntry(raw: string, file: string): ProcessEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw invalidFileRead(`process registry entry is corrupt JSON: ${file}`, "EPROCESSREGISTRYINVALID", cause);
  }
  const entry = recordValue(parsed) as ProcessEntry;
  if (!validPersistentProcessEntry(entry, path.basename(file, ".json"))) {
    throw invalidFileRead(`process registry entry is invalid: ${file}`, "EPROCESSREGISTRYINVALID");
  }
  return entry;
}

async function readJsonFileSnapshot(file: string): Promise<{ entry: ProcessEntry; generation: FileGeneration } | null> {
  try {
    const snapshot = await readBoundedNoFollowFileSnapshot(file, {
      maxBytes: PROCESS_RECORD_MAX_BYTES,
      kind: "process registry entry",
      invalidCode: "EPROCESSREGISTRYINVALID",
      afterLstat: async () => {
        await infraLockTestHooks().afterProcessEntryLstat?.({ processFile: file });
      },
    });
    return { entry: parseProcessEntry(snapshot.raw, file), generation: snapshot.generation };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readJsonFile(file: string): Promise<ProcessEntry | null> {
  return (await readJsonFileSnapshot(file))?.entry ?? null;
}

async function writeJsonFile(file: string, data: unknown, expectedTargetGeneration?: FileGeneration | null) {
  const entry = recordValue(data) as ProcessEntry;
  if (!validPersistentProcessEntry(entry, path.basename(file, ".json"))) {
    throw invalidFileRead(`process registry entry is invalid before publication: ${file}`, "EPROCESSREGISTRYINVALID");
  }
  await durableAtomicWriteJson(
    file,
    data,
    "DURABLE_PROCESS_REGISTRY_COMMITTED_DURABILITY_AMBIGUOUS",
    expectedTargetGeneration,
  );
}

async function withProcessFileLock<T>(file: string, callback: () => Promise<T>, { lockTtlMs }: LeaseLockOptions = {}): Promise<T> {
  const lock = await acquireLeaseFileLock(file, { purpose: "process-registry", lockTtlMs });
  let primaryError: unknown = null;
  try {
    return await lock.run(callback);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      if (primaryError) throw combineFileLockErrors("process registry operation and lock release failed", [primaryError, releaseError]);
      throw releaseError;
    }
  }
}

function processRegistryError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function capturedIdentity(pid: number, processSystem?: ProcessTreeSystem) {
  const identity = captureExactProcessIdentity(pid, processSystem);
  if (!identity) {
    throw processRegistryError(
      `process ${pid} exited before its OS incarnation could be registered`,
      "PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  return identity;
}

function observedProcessIdentity(
  expected: ProcessIdentity,
  processSystem?: ProcessTreeSystem,
): "alive" | "gone" {
  const kill = processSystem?.kill || process.kill;
  try {
    kill(expected.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "gone";
    throw error;
  }
  const current = captureExactProcessIdentity(expected.pid, processSystem);
  if (!current) {
    try {
      kill(expected.pid, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return "gone";
      throw error;
    }
    throw processRegistryError(
      `process ${expected.pid} is alive but its exact incarnation is unavailable`,
      "PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  if (!sameProcessIdentity(expected, current)) {
    throw processRegistryError(
      `process ${expected.pid} incarnation no longer matches the registry`,
      "PROCESS_IDENTITY_MISMATCH",
    );
  }
  return "alive";
}

function signalTrackingProcessSystem(
  processSystem: ProcessTreeSystem | undefined,
  deliveredPids: Set<number>,
): ProcessTreeSystem {
  const base: ProcessTreeSystem = processSystem ?? {
    platform: process.platform,
    spawnSync,
    kill: process.kill,
    captureIdentity: (pid) => captureProcessIdentity(pid, { strict: true }),
  };
  return {
    ...base,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      const result = base.kill(pid, signal);
      if (signal !== undefined && signal !== 0) deliveredPids.add(Math.abs(pid));
      return result;
    }) as ProcessTreeSystem["kill"],
  };
}

function stopSignalTruth(
  candidatePids: number[],
  attemptedPids: number[],
  deliveredPids: Set<number>,
  verifiedStoppedPids: number[],
) {
  const attempted = new Set(attemptedPids);
  const verified = new Set(verifiedStoppedPids);
  return {
    candidatePids: [...candidatePids],
    attemptedPids: candidatePids.filter((pid) => attempted.has(pid)),
    signaledPids: candidatePids.filter((pid) => deliveredPids.has(pid)),
    verifiedStoppedPids: candidatePids.filter((pid) => verified.has(pid)),
    signalOutcomeUnknownPids: candidatePids.filter((pid) => attempted.has(pid) && !verified.has(pid)),
  };
}

async function processPublicationFailureTruth(
  error: unknown,
  file: string,
  previousGeneration: FileGeneration,
  previousStatus: string,
  intendedStatus: string,
) {
  const failure = recordValue(error);
  const recoveryPaths = recordValue(failure.recoveryPaths);
  const exactCanonicalCommit = failure.committed === true
    && failure.committedPath === file
    && failure.lineageLost !== true
    && recoveryPaths.path === file;
  if (exactCanonicalCommit) {
    return {
      statusCommitted: true,
      statusCommitState: "committed",
      durableStatus: intendedStatus,
    };
  }
  if (failure.committed === true) {
    return {
      statusCommitted: null,
      statusCommitState: "unknown",
      durableStatus: null,
    };
  }
  const currentGeneration = await fileGeneration(file).catch(() => null);
  if (sameFileGeneration(previousGeneration, currentGeneration)) {
    return {
      statusCommitted: false,
      statusCommitState: "not_committed",
      durableStatus: previousStatus,
    };
  }
  return {
    statusCommitted: null,
    statusCommitState: "unknown",
    durableStatus: null,
  };
}

export async function registerProcess(cpbRoot: string, { jobId, project, phase, runnerPid, treeId, leaseId, command, startedAt, cwd, executorRoot, dataRoot, includeLegacyFallback = false, processSystem }: RegisterProcessOptions = {}) {
  validateId(jobId, "jobId");
  const registeredPid = runnerPid === undefined ? process.pid : positiveSafePid(runnerPid, "runnerPid");
  const processIdentity = capturedIdentity(registeredPid, processSystem);
  const file = await processFile(cpbRoot, jobId, { dataRoot, includeLegacyFallback });
  const entry: ProcessEntry = {
    formatVersion: PROCESS_REGISTRY_FORMAT_VERSION,
    jobId,
    project: project || null,
    phase: phase || null,
    runnerPid: registeredPid,
    processIdentity,
    treeId: treeId || null,
    childPids: [],
    childIdentities: [],
    leaseId: leaseId || null,
    startedAt: startedAt || nowIso(),
    lastHeartbeat: nowIso(),
    status: "running",
    exitCode: null,
    command: command || null,
    cwd: cwd || null,
    executorRoot: executorRoot || null,
  };
  return await withProcessFileLock(file, async () => {
    if (observedProcessIdentity(processIdentity, processSystem) === "gone") {
      throw processRegistryError(
        `process ${registeredPid} exited before its registry entry could be published`,
        "PROCESS_IDENTITY_UNAVAILABLE",
      );
    }
    const existing = await readJsonFileSnapshot(file);
    await writeJsonFile(file, entry, existing?.generation ?? null);
    return entry;
  });
}

export async function updateHeartbeat(cpbRoot: string, jobId: string, options: RuntimeStorageOptions = {}) {
  const file = await processFile(cpbRoot, jobId, options);
  return await withProcessFileLock(file, async () => {
    const snapshot = await readJsonFileSnapshot(file);
    if (!snapshot) return null;
    const entry = snapshot.entry;
    entry.lastHeartbeat = nowIso();
    await writeJsonFile(file, entry, snapshot.generation);
    return entry;
  });
}

export async function markExited(cpbRoot: string, jobId: string, { exitCode, status = "exited", dataRoot, includeLegacyFallback = false }: MarkExitedOptions = {}) {
  const file = await processFile(cpbRoot, jobId, { dataRoot, includeLegacyFallback });
  return await withProcessFileLock(file, async () => {
    const snapshot = await readJsonFileSnapshot(file);
    if (!snapshot) return null;
    const entry = snapshot.entry;
    entry.status = status;
    entry.exitCode = exitCode ?? null;
    await writeJsonFile(file, entry, snapshot.generation);
    return entry;
  });
}

export async function addChildPid(cpbRoot: string, jobId: string, childPid: number, options: ProcessRegistryOptions = {}) {
  const registeredChildPid = positiveSafePid(childPid, "childPid");
  const file = await processFile(cpbRoot, jobId, options);
  return await withProcessFileLock(file, async () => {
    const snapshot = await readJsonFileSnapshot(file);
    if (!snapshot) return null;
    const entry = snapshot.entry;
    const processSystem = options.processSystem as ProcessTreeSystem | undefined;
    const childIdentity = capturedIdentity(registeredChildPid, processSystem);
    if (!Array.isArray(entry.childPids) || !Array.isArray(entry.childIdentities)) {
      throw processRegistryError(`process registry entry ${jobId} has invalid child identity arrays`, "EPROCESSREGISTRYINVALID");
    }
    if (!entry.childPids.includes(registeredChildPid)) {
      entry.childPids.push(registeredChildPid);
    }
    if (!entry.childIdentities.some((identity) => sameProcessIdentity(identity, childIdentity))) {
      entry.childIdentities.push(childIdentity);
    }
    await writeJsonFile(file, entry, snapshot.generation);
    return entry;
  });
}

export async function getProcess(cpbRoot: string, jobId: string, options: RuntimeStorageOptions = {}) {
  const file = await processFile(cpbRoot, jobId, options);
  return await withProcessFileLock(file, async () => readJsonFile(file));
}

export async function listProcesses(cpbRoot: string, options: RuntimeStorageOptions = {}): Promise<ProcessEntry[]> {
  const dir = await processDir(cpbRoot, options);
  const entries = await readDirectoryNamesNoFollow(dir, "EPROCESSREGISTRYINVALID");
  const results: ProcessEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const jobId = name.slice(0, -".json".length);
    try {
      validateId(jobId, "jobId");
    } catch (cause) {
      throw Object.assign(new Error(`invalid process registry filename: ${name}`, { cause }), {
        code: "EPROCESSREGISTRYINVALID",
      });
    }
    const entry = await getProcess(cpbRoot, jobId, options);
    if (entry) {
      entry.liveness = classifyLiveness(entry);
      entry.ageMs = computeAge(entry);
      results.push(entry);
    }
  }
  return results;
}

const PROCESS_IDENTITY_REQUIRED_KEYS = [
  "pid",
  "birthId",
  "incarnation",
  "capturedAt",
  "birthIdPrecision",
] as const;

function registeredProcessIdentity(value: unknown, expectedPid?: number): ProcessIdentity | null {
  const candidate = recordValue(value);
  const processGroupId = candidate.processGroupId;
  if (
    !hasExactKeys(candidate, PROCESS_IDENTITY_REQUIRED_KEYS, ["processGroupId"])
    || typeof candidate.pid !== "number"
    || !Number.isSafeInteger(candidate.pid)
    || Number(candidate.pid) <= 0
    || (expectedPid !== undefined && Number(candidate.pid) !== expectedPid)
    || candidate.birthIdPrecision !== "exact"
    || typeof candidate.birthId !== "string"
    || !candidate.birthId
    || typeof candidate.incarnation !== "string"
    || candidate.incarnation !== `${candidate.pid}:${candidate.birthId}`
    || typeof candidate.capturedAt !== "string"
    || Number.isNaN(new Date(candidate.capturedAt).getTime())
    || new Date(Date.parse(candidate.capturedAt)).toISOString() !== candidate.capturedAt
    || (candidate.processGroupId !== undefined
      && (typeof processGroupId !== "number" || !Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  return {
    pid: Number(candidate.pid),
    birthId: String(candidate.birthId),
    incarnation: String(candidate.incarnation),
    capturedAt: String(candidate.capturedAt),
    birthIdPrecision: "exact",
    ...(candidate.processGroupId === undefined ? {} : { processGroupId: Number(processGroupId) }),
  };
}

export function computeAge(entry: LooseRecord) {
  if (typeof entry?.startedAt !== "string") return null;
  const started = new Date(entry.startedAt).getTime();
  if (Number.isNaN(started)) return null;
  return Date.now() - started;
}

export function classifyLiveness(
  entry: LooseRecord | null | undefined,
  {
    staleThresholdMs = 180_000,
    processSystem,
  }: { staleThresholdMs?: number; processSystem?: ProcessTreeSystem } = {},
) {
  if (!entry) return "unknown";
  if (entry.status === "exited" || entry.status === "stopped") return entry.status;

  if (typeof entry.runnerPid !== "number" || !Number.isSafeInteger(entry.runnerPid) || entry.runnerPid <= 0) return "unknown";
  const runnerPid = entry.runnerPid;
  const identity = registeredProcessIdentity(entry.processIdentity, runnerPid);
  if (!identity) return "unknown";
  try {
    if (observedProcessIdentity(identity, processSystem) === "gone") return "orphan";
  } catch (error) {
    if (errorCode(error) === "PROCESS_IDENTITY_MISMATCH") return "identity_mismatch";
    throw error;
  }

  if (typeof entry.lastHeartbeat !== "string") return "unknown";
  const lastHb = new Date(entry.lastHeartbeat).getTime();
  if (Number.isNaN(lastHb)) return "unknown";
  const age = Date.now() - lastHb;
  if (age > staleThresholdMs) return "stale";

  return "alive";
}

export async function stopProcess(cpbRoot: string, jobId: string, options: ProcessRegistryOptions = {}) {
  const {
    dataRoot,
    includeLegacyFallback = false,
    processSystem,
    graceMs = 2_000,
    forceVerifyMs = 1_000,
  } = options;
  const effectiveGraceMs = processStopWaitMs(graceMs, "graceMs");
  const effectiveForceVerifyMs = processStopWaitMs(forceVerifyMs, "forceVerifyMs");
  const file = await processFile(cpbRoot, jobId, { dataRoot, includeLegacyFallback });
  return await withProcessFileLock(file, async () => {
    const snapshot = await readJsonFileSnapshot(file);
    if (!snapshot) return { stopped: false, reason: "not found" };
    const entry = snapshot.entry;

    const { project } = entry;
    const ts = nowIso();

    async function audit(
      type: string,
      extra: LooseRecord = {},
      truth: LooseRecord = {},
    ) {
      if (!project) return;
      try {
        await infraLockTestHooks().beforeProcessAudit?.({ type, jobId, project });
        const { appendEvent } = await import("./event/event-store.js");
        await appendEvent(
          cpbRoot,
          project,
          jobId,
          { type, jobId, project, runnerPid: entry.runnerPid, ts, ...extra },
          { dataRoot },
        );
      } catch (cause) {
        throw Object.assign(
          new AggregateError([cause], `process stop audit publication failed: ${type}`, { cause }),
          {
            code: "PROCESS_STOP_AUDIT_FAILED",
            auditType: type,
            jobId,
            ...truth,
          },
        );
      }
    }

    if (entry.status === "exited" || entry.status === "stopped") {
      const skippedTruth = {
        statusCommitted: true,
        statusCommitState: "committed",
        durableStatus: entry.status,
        candidatePids: [] as number[],
        attemptedPids: [] as number[],
        signaledPids: [] as number[],
        verifiedStoppedPids: [] as number[],
        signalOutcomeUnknownPids: [] as number[],
      };
      await audit(
        "process_stop_skipped",
        { reason: `already ${entry.status}` },
        skippedTruth,
      );
      return { stopped: false, reason: `already ${entry.status}`, ...skippedTruth };
    }

    const runnerPid = entry.runnerPid;
    const runnerIdentity = registeredProcessIdentity(entry.processIdentity, runnerPid);
    if (!runnerIdentity) {
      throw processRegistryError(
        `process registry entry ${jobId} lacks OS process identity; refusing bare-pid stop`,
        "PROCESS_IDENTITY_UNAVAILABLE",
      );
    }

    const deliveredPids = new Set<number>();
    const trackedProcessSystem = signalTrackingProcessSystem(processSystem, deliveredPids);
    if (observedProcessIdentity(runnerIdentity, trackedProcessSystem) === "gone") {
      const previousStatus = entry.status;
      entry.status = "orphan";
      entry.exitCode = null;
      try {
        await writeJsonFile(file, entry, snapshot.generation);
      } catch (error) {
        if (error && typeof error === "object") {
          Object.assign(error, await processPublicationFailureTruth(
            error,
            file,
            snapshot.generation,
            previousStatus,
            "orphan",
          ), {
            candidatePids: [],
            attemptedPids: [],
            signaledPids: [],
            verifiedStoppedPids: [runnerIdentity.pid],
            signalOutcomeUnknownPids: [],
          });
        }
        throw error;
      }
      await audit(
        "process_marked_orphan",
        { processIncarnation: runnerIdentity.incarnation },
        {
          statusCommitted: true,
          statusCommitState: "committed",
          durableStatus: "orphan",
          candidatePids: [],
          attemptedPids: [],
          signaledPids: [],
          verifiedStoppedPids: [runnerIdentity.pid],
          signalOutcomeUnknownPids: [],
        },
      );
      return {
        stopped: false,
        reason: "process already dead (marked orphan)",
        candidatePids: [],
        attemptedPids: [],
        signaledPids: [],
        verifiedStoppedPids: [runnerIdentity.pid],
        signalOutcomeUnknownPids: [],
      };
    }

    const rawChildPids = Array.isArray(entry.childPids) ? entry.childPids : [];
    const rawChildIdentities = Array.isArray(entry.childIdentities) ? entry.childIdentities : [];
    const uniqueChildPids = new Set(rawChildPids);
    const childIdentities = rawChildPids.map((pid) =>
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
        ? registeredProcessIdentity(rawChildIdentities.find((value) => recordValue(value).pid === pid), pid)
        : null
    );
    if (
      uniqueChildPids.size !== rawChildPids.length
      || rawChildIdentities.length !== rawChildPids.length
      || childIdentities.some((identity) => !identity)
      || rawChildIdentities.some((value) => {
        const identity = registeredProcessIdentity(value);
        return !identity || !uniqueChildPids.has(identity.pid);
      })
    ) {
      throw processRegistryError(
        `process registry entry ${jobId} contains child PIDs without a one-to-one exact OS incarnation`,
        "PROCESS_IDENTITY_UNAVAILABLE",
      );
    }
    const identities = [runnerIdentity, ...childIdentities.filter((identity): identity is ProcessIdentity => Boolean(identity))];
    const candidatePids = identities.map((identity) => identity.pid);
    await audit("process_stop_requested", {
      candidatePids,
      processIncarnations: identities.map((identity) => identity.incarnation),
    }, {
      statusCommitted: false,
      statusCommitState: "not_committed",
      durableStatus: entry.status,
      candidatePids,
      attemptedPids: [],
      signaledPids: [],
      verifiedStoppedPids: [],
      signalOutcomeUnknownPids: [],
    });

    const attemptedPids: number[] = [];
    const verifiedStoppedPids: number[] = [];
    for (const identity of identities) {
      if (observedProcessIdentity(identity, trackedProcessSystem) === "gone") {
        verifiedStoppedPids.push(identity.pid);
        continue;
      }
      attemptedPids.push(identity.pid);
      try {
        await killTree(identity.pid, effectiveGraceMs, {
          expectedRootIdentity: identity,
          requireDescendantScan: true,
          forceVerifyMs: effectiveForceVerifyMs,
          system: trackedProcessSystem,
        });
        verifiedStoppedPids.push(identity.pid);
      } catch (cause) {
        const signalTruth = stopSignalTruth(candidatePids, attemptedPids, deliveredPids, verifiedStoppedPids);
        throw Object.assign(
          new AggregateError([cause], `process stop signaling or verification failed for ${identity.pid}`, { cause }),
          {
            code: errorCode(cause) || "PROCESS_STOP_SIGNAL_FAILED",
            jobId,
            statusCommitted: false,
            statusCommitState: "not_committed",
            durableStatus: entry.status,
            ...signalTruth,
          },
        );
      }
    }

    const signalTruth = stopSignalTruth(candidatePids, attemptedPids, deliveredPids, verifiedStoppedPids);
    const previousStatus = entry.status;
    entry.status = "stopped";
    entry.exitCode = signalTruth.signaledPids.includes(runnerPid) ? -15 : null;
    try {
      await writeJsonFile(file, entry, snapshot.generation);
    } catch (error) {
      if (error && typeof error === "object") {
        Object.assign(error, await processPublicationFailureTruth(
          error,
          file,
          snapshot.generation,
          previousStatus,
          "stopped",
        ), signalTruth);
      }
      throw error;
    }
    await audit(
      "process_stopped",
      signalTruth,
      {
        statusCommitted: true,
        statusCommitState: "committed",
        durableStatus: "stopped",
        ...signalTruth,
      },
    );
    return { stopped: true, jobId, ...signalTruth };
  });
}

export async function cleanProcesses(cpbRoot: string, {
  dryRun = false,
  dataRoot,
  includeLegacyFallback = false,
  processSystem,
}: ProcessRegistryOptions = {}) {
  const storageOptions = { dataRoot, includeLegacyFallback };
  const entries = await listProcesses(cpbRoot, storageOptions);
  const eligible: ProcessEntry[] = [];

  for (const entry of entries) {
    const liveness = classifyLiveness(entry, { processSystem });
    if (liveness === "exited" || liveness === "orphan") {
      eligible.push(entry);
    }
  }

  if (dryRun) {
    return { dryRun: true, removed: [], eligible };
  }

  const removed: string[] = [];
  for (const entry of eligible) {
    const file = await processFile(cpbRoot, entry.jobId, storageOptions);
    const outcome = await withProcessFileLock(file, async () => {
      const snapshot = await readJsonFileSnapshot(file);
      if (!snapshot) return null;
      const currentLiveness = classifyLiveness(snapshot.entry, { processSystem });
      if (currentLiveness !== "exited" && currentLiveness !== "orphan") return null;
      return await removePathDurably(file, {
        force: true,
        faultPoint: "after-process-remove",
        ambiguityCode: "DURABLE_PROCESS_REGISTRY_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
        expectedGeneration: snapshot.generation,
      });
    });
    if (outcome?.removed) removed.push(entry.jobId);
  }
  return { dryRun: false, removed, eligible };
}

export async function removeProcess(cpbRoot: string, jobId: string, {
  dryRun = false,
  dataRoot,
  includeLegacyFallback = false,
  lockTtlMs,
}: ProcessRegistryOptions & LeaseLockOptions = {}) {
  validateId(jobId, "jobId");
  const file = await processFile(cpbRoot, jobId, { dataRoot, includeLegacyFallback });
  return await withProcessFileLock(file, async () => {
    const snapshot = await readJsonFileSnapshot(file);
    if (dryRun) {
      return { removed: false, wouldRemove: Boolean(snapshot), jobId };
    }
    if (!snapshot) {
      return { removed: false, wouldRemove: false, jobId, committedPath: null, recoveryPaths: [] as string[] };
    }
    const removal = await removePathDurably(file, {
      force: true,
      faultPoint: "after-process-remove",
      ambiguityCode: "DURABLE_PROCESS_REGISTRY_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
      expectedGeneration: snapshot.generation,
    });
    return { ...removal, wouldRemove: true, jobId };
  }, {
    lockTtlMs,
  });
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
