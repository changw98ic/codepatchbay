import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildChildEnv } from "../../core/policy/child-env.js";
import { recordValue, type LooseRecord } from "../../shared/types.js";

export const REQUIRED_EXECUTOR_FILES = [
  "cpb",
  "cli/cpb.js",
  "bridges/engine-bridge.js",
  "bridges/runtime-services.js",
  "core/workflow/definition.js",
  "shared/fs-utils.js",
  "shared/hub-auth.js",
  "shared/hub-maintenance.js",
  "shared/logger.js",
  "shared/orchestrator/assignment-store.js",
  "shared/orchestrator/worker-store.js",
  "server/index.js",
  "server/services/audit/hub-access-audit.js",
  "server/services/audit/hub-access-audit-archive.js",
  "server/services/acp/acp-client.js",
  "server/services/engine-runner.js",
  "server/services/apply-variant.js",
  "server/services/executor-root.js",
  "server/services/setup-events.js",
  "server/services/event/event-store.js",
  "server/services/hub/hub-backup.js",
  "server/services/hub/hub-queue.js",
  "server/services/hub/hub-registry.js",
  "server/services/job/job-store.js",
  "server/services/release/release-store.js",
  "scripts/write-dist-metadata.js",
  "scripts/validate-scan-readiness.js",
  "runtime/evolve/multi-evolve.js",
  "runtime/worker/managed-worker.js",
];

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringEnv(value: unknown): Record<string, string | undefined> {
  const record = recordValue(value);
  const env: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(record)) {
    env[key] = entry == null ? undefined : String(entry);
  }
  return env;
}

export function resolveExecutorRoot({ env = process.env, fallbackRoot = process.cwd() }: LooseRecord = {}) {
  const envRecord = recordValue(env);
  return path.resolve(stringValue(envRecord.CPB_EXECUTOR_ROOT) || stringValue(fallbackRoot));
}

export function executorEnv(env: LooseRecord = process.env, { cpbRoot, executorRoot, extra }: LooseRecord = {}) {
  const envRecord = recordValue(env);
  return buildChildEnv(stringEnv(envRecord), {
    CPB_ROOT: path.resolve(stringValue(cpbRoot) || stringValue(envRecord.CPB_ROOT) || process.cwd()),
    CPB_EXECUTOR_ROOT: path.resolve(stringValue(executorRoot) || stringValue(envRecord.CPB_EXECUTOR_ROOT) || stringValue(cpbRoot) || process.cwd()),
    ...stringEnv(extra),
  });
}

export async function assertExecutorRoot(executorRoot: string) {
  const root = path.resolve(executorRoot);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error(`executor root is not a directory: ${root}`);
  }

  for (const relativePath of REQUIRED_EXECUTOR_FILES) {
    try {
      await access(path.join(root, relativePath), fsConstants.R_OK);
    } catch {
      throw new Error(`executor root is missing ${relativePath}: ${root}`);
    }
  }

  return root;
}

export async function readExecutorPackage(executorRoot: string) {
  try {
    const raw = await readFile(path.join(path.resolve(executorRoot), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      name: parsed.name || null,
      version: parsed.version || null,
    };
  } catch {
    return {
      name: null,
      version: null,
    };
  }
}

export async function executorMetadata(executorRoot: string, { codeVersion, env = process.env }: LooseRecord = {}) {
  const root = await assertExecutorRoot(executorRoot);
  const pkg = await readExecutorPackage(root);
  const envRecord = recordValue(env);

  let releaseId = null;
  let stateFormatVersions = null;
  try {
    const manifestPath = path.join(root, "release", "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (typeof manifest.releaseId === "string" && manifest.releaseId.length > 0) {
      releaseId = manifest.releaseId;
    }
    if (manifest.stateFormatVersions && typeof manifest.stateFormatVersions === "object") {
      stateFormatVersions = manifest.stateFormatVersions;
    }
  } catch {}

  if (!stateFormatVersions) {
    try {
      const { QUEUE_VERSION } = await import("./hub/hub-queue.js");
      const { JOBS_EVENTS_FORMAT_VERSION } = await import("./event/event-store.js");
      const { LEASE_FORMAT_VERSION } = await import("./infra.js");
      const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("./infra.js");
      const { RELEASE_METADATA_FORMAT_VERSION } = await import("./release/release-store.js");
      stateFormatVersions = {
        queue: QUEUE_VERSION,
        jobsEvents: JOBS_EVENTS_FORMAT_VERSION,
        leases: LEASE_FORMAT_VERSION,
        processRegistry: PROCESS_REGISTRY_FORMAT_VERSION,
        releaseMetadata: RELEASE_METADATA_FORMAT_VERSION,
      };
    } catch {
      stateFormatVersions = null;
    }
  }

  return {
    root,
    packageName: pkg.name,
    version: pkg.version,
    releaseId,
    codeVersion: stringValue(codeVersion) || stringValue(envRecord.CPB_VERSION) || pkg.version || null,
    stateFormatVersions,
  };
}
