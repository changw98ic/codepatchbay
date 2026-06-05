import { runJob } from "../../core/engine/run-job.js";
import { createJob, startPhase, completePhase, completeJob, failJob } from "./job-store.js";
import { appendEvent } from "./event-store.js";
import { getManagedAcpPool } from "./acp-pool.js";
import { resolveHubRoot, getProject } from "./hub-registry.js";
import { assertProviderAvailable } from "./provider-quota.js";
import { getProviderAdapter } from "./provider-adapters.js";
import {
  delegateMarkProviderUnavailable,
  delegateEnqueueProviderUsage,
} from "./quota-delegate-client.js";

export function buildServices(cpbRoot, { hubRoot = null, env = process.env } = {}) {
  return {
    createJob,
    startPhase,
    completePhase,
    completeJob,
    failJob,
    appendEvent,
    getPool: () => getManagedAcpPool({ cpbRoot, hubRoot, env }),
    providerServices: {
      assertProviderAvailable,
      getProviderAdapter,
      delegateMarkProviderUnavailable,
      delegateEnqueueProviderUsage,
    },
  };
}

export async function runJobWithServices(opts) {
  const { cpbRoot, project, sourcePath: explicitSourcePath, hubRoot: explicitHubRoot } = opts;
  const { sourcePath: resolvedSourcePath, hubRoot: resolvedHubRoot } = await resolveSourcePath(cpbRoot, project);
  const hubRoot = explicitHubRoot || resolvedHubRoot;
  const services = buildServices(cpbRoot, { hubRoot, env: opts.env || process.env });
  const callerProvidedProviderServices = opts.providerServices !== undefined;
  return runJob({
    ...opts,
    hubRoot,
    sourcePath: explicitSourcePath || resolvedSourcePath,
    routing: opts.routing || null,
    agentAvailability: opts.agentAvailability || null,
    agentHealth: opts.agentHealth || null,
    teamPolicy: opts.teamPolicy || null,
    ...services,
    providerServices: callerProvidedProviderServices ? opts.providerServices : services.providerServices,
  });
}

async function resolveSourcePath(cpbRoot, project) {
  try {
    const hubRoot = resolveHubRoot(cpbRoot);
    const registered = await getProject(hubRoot, project);
    return { sourcePath: registered?.sourcePath || null, hubRoot };
  } catch {
    return { sourcePath: null, hubRoot: null };
  }
}
