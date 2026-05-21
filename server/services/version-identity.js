import { readFile } from "node:fs/promises";
import path from "node:path";
import { RELEASE_METADATA_FORMAT_VERSION } from "./release-store.js";

export { RELEASE_METADATA_FORMAT_VERSION };

export async function buildVersionIdentityReport({ cpbRoot, executorRoot, codeVersion, env = process.env }) {
  const resolvedCpbRoot = path.resolve(cpbRoot);
  const resolvedExecutorRoot = path.resolve(executorRoot);

  const { resolveHubRoot } = await import("./hub-registry.js");
  const hubRoot = resolveHubRoot(resolvedCpbRoot);

  let activeAppReleaseId = null;
  try {
    const manifestPath = path.join(resolvedExecutorRoot, "release", "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (typeof manifest.releaseId === "string" && manifest.releaseId.length > 0) {
      activeAppReleaseId = manifest.releaseId;
    }
  } catch {}

  const { QUEUE_VERSION } = await import("./hub-queue.js");
  const { JOBS_EVENTS_FORMAT_VERSION } = await import("./event-store.js");
  const { LEASE_FORMAT_VERSION } = await import("./lease-manager.js");
  const { PROCESS_REGISTRY_FORMAT_VERSION } = await import("./process-registry.js");

  return {
    codeVersion,
    runtimeBackend: "node",
    runtimeBinaryPath: null,
    CPB_ROOT: resolvedCpbRoot,
    CPB_EXECUTOR_ROOT: resolvedExecutorRoot,
    hubRoot,
    activeAppReleaseId,
    stateFormatVersions: {
      queue: QUEUE_VERSION,
      jobsEvents: JOBS_EVENTS_FORMAT_VERSION,
      leases: LEASE_FORMAT_VERSION,
      processRegistry: PROCESS_REGISTRY_FORMAT_VERSION,
      releaseMetadata: RELEASE_METADATA_FORMAT_VERSION,
    },
  };
}
