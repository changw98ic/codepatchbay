// @ts-nocheck
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildChildEnv } from "../../core/policy/child-env.js";

export const REQUIRED_EXECUTOR_FILES = [
  "cpb",
  "cli/cpb.js",
  "bridges/engine-bridge.js",
  "bridges/runtime-services.js",
  "core/workflow/definition.js",
  "shared/fs-utils.js",
  "shared/logger.js",
  "shared/orchestrator/assignment-store.js",
  "shared/orchestrator/worker-store.js",
  "server/services/acp-client-core.js",
  "server/services/browser-agent-acp.js",
  "server/services/dual-research.js",
  "server/services/engine-runner.js",
  "server/services/event-store.js",
  "server/services/evolve-multi-cli.js",
  "server/services/hub-queue.js",
  "server/services/hub-registry.js",
  "server/services/init-project.js",
  "server/services/job-store.js",
  "server/services/local-smoke.js",
  "server/services/merge-research.js",
  "server/services/release-store.js",
  "server/services/review-dispatch-runner.js",
  "server/services/test-acp-agent.js",
  "web/dist/index.html",
  "scripts/provider-soak.js",
  "scripts/validate-scan-readiness.js",
  "runtime/evolve/multi-evolve.js",
  "runtime/worker/managed-worker.js",
];

export function resolveExecutorRoot({ env = process.env, fallbackRoot = process.cwd() } = {}) {
  return path.resolve(env.CPB_EXECUTOR_ROOT || fallbackRoot);
}

export function executorEnv(env = process.env, { cpbRoot, executorRoot } = {}) {
  return buildChildEnv(env, {
    CPB_ROOT: path.resolve(cpbRoot || env.CPB_ROOT || process.cwd()),
    CPB_EXECUTOR_ROOT: path.resolve(executorRoot || env.CPB_EXECUTOR_ROOT || cpbRoot || process.cwd()),
  });
}

export async function assertExecutorRoot(executorRoot) {
  const root = path.resolve(executorRoot);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error(`executor root is not a directory: ${root}`);
  }

  for (const relativePath of REQUIRED_EXECUTOR_FILES) {
    try {
      await access(path.join(root, relativePath));
    } catch {
      throw new Error(`executor root is missing ${relativePath}: ${root}`);
    }
  }

  return root;
}

export async function readExecutorPackage(executorRoot) {
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

export async function executorMetadata(executorRoot, { codeVersion, env = process.env } = {}) {
  const root = await assertExecutorRoot(executorRoot);
  const pkg = await readExecutorPackage(root);

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
      const { QUEUE_VERSION } = await import("./hub-queue.js");
      const { JOBS_EVENTS_FORMAT_VERSION } = await import("./event-store.js");
      const { LEASE_FORMAT_VERSION } = await import("./lease-manager.js");
      const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("./process-registry.js");
      const { RELEASE_METADATA_FORMAT_VERSION } = await import("./release-store.js");
      stateFormatVersions = {
        queue: QUEUE_VERSION,
        jobsEvents: JOBS_EVENTS_FORMAT_VERSION,
        leases: LEASE_FORMAT_VERSION,
        processRegistry: PROCESS_REGISTRY_FORMAT_VERSION,
        releaseMetadata: RELEASE_METADATA_FORMAT_VERSION,
      };
    } catch {}
  }

  return {
    root,
    packageName: pkg.name,
    version: pkg.version,
    releaseId,
    codeVersion: codeVersion || env.CPB_VERSION || pkg.version || null,
    stateFormatVersions,
  };
}
