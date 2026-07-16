import { isRecord, recordValue, type LooseRecord } from "../../shared/types.js";
import { runJob } from "../../core/engine/run-job.js";
import { mkdir } from "node:fs/promises";
import { createJob, startPhase, completePhase, completeJob, failJob, blockJob } from "./job/job-store.js";
import { appendEvent } from "./event/event-store.js";
import type { EventRecord } from "./event/event-types.js";
import { getManagedAcpPool } from "./acp/acp-pool.js";
import { resolveHubRoot, getProject } from "./hub/hub-registry.js";
import { assertProviderAvailable } from "./provider-quota.js";
import { getProviderAdapter } from "./provider-adapters.js";
import { readAgentRoutingMetrics } from "./provider-usage.js";
import { prepareTask } from "./project/project-loader.js";
import { buildArtifactIndex } from "./job/job-projection.js";
import { addChildPid } from "./infra.js";
import {
  delegateMarkProviderUnavailable,
  delegateEnqueueProviderUsage,
} from "./quota-delegate-client.js";
import { WorkerBrokerClient } from "../../shared/orchestrator/worker-broker-client.js";

function prepareTaskForEnv(env: Record<string, string | undefined>) {
  if (env?.CPB_ACP_FAKE_ACP_COMMAND) {
    return async (): Promise<LooseRecord> => ({
      riskLevel: "low",
      domains: ["test_fixture"],
      highRiskFiles: [] as string[],
      safetyBoundaries: [] as string[],
      verificationDepth: "standard",
      adversarialRequired: false,
      adversarialFocus: [] as string[],
      confidence: "high",
      generatedAt: new Date().toISOString(),
      source: { testFixture: true },
    });
  }
  return prepareTask;
}

function createJobInput(opts: LooseRecord, dataRoot: string) {
  const { executor, ...rest } = opts;
  const input: LooseRecord & { dataRoot: string; executor?: string | LooseRecord | null } = { ...rest, dataRoot };
  if (executor == null) input.executor = null;
  else if (typeof executor === "string" || isRecord(executor)) input.executor = executor;
  return input;
}

export function buildServices(cpbRoot: string, {
  hubRoot = null,
  env = process.env,
  dataRoot = null,
  workerBrokerClient = null,
}: LooseRecord = {}) {
  const runtimeEnv = envRecord(env);
  const runtimeDataRoot = typeof dataRoot === "string" ? dataRoot : null;
  const broker = workerBrokerClient instanceof WorkerBrokerClient ? workerBrokerClient : null;
  const withJobOptions = (fn: (...args: unknown[]) => unknown) => runtimeDataRoot
    ? (root: string, project: string, jobId: string, opts: LooseRecord = {}) => fn(root, project, jobId, { ...opts, dataRoot: runtimeDataRoot })
    : fn;
  return {
    createJob: broker
      ? (root: string, opts: LooseRecord = {}) => broker.createJob(root, createJobInput(opts, runtimeDataRoot || ""))
      : runtimeDataRoot
      ? (root: string, opts: LooseRecord = {}) => createJob(root, createJobInput(opts, runtimeDataRoot))
      : createJob,
    startPhase: broker ? broker.startPhase.bind(broker) : withJobOptions(startPhase),
    completePhase: broker ? broker.completePhase.bind(broker) : withJobOptions(completePhase),
    completeJob: broker
      ? broker.completeJob.bind(broker)
      : runtimeDataRoot
      ? (root: string, project: string, jobId: string, opts: LooseRecord = {}) => completeJob(root, project, jobId, { ...opts, dataRoot: runtimeDataRoot })
      : completeJob,
    failJob: broker ? broker.failJob.bind(broker) : withJobOptions(failJob),
    blockJob: broker ? broker.blockJob.bind(broker) : withJobOptions(blockJob),
    appendEvent: broker
      ? broker.appendEvent.bind(broker)
      : runtimeDataRoot
      ? (root: string, project: string, jobId: string, event: EventRecord, opts: LooseRecord = {}) => {
        if (typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) {
          throw new Error(`invalid jobId for appendEvent: ${JSON.stringify(jobId)}`);
        }
        return appendEvent(root, project, jobId, event, { ...opts, dataRoot: runtimeDataRoot, includeLegacyFallback: false });
      }
      : appendEvent,
    prepareTask: prepareTaskForEnv(runtimeEnv),
    getPool: () => getManagedAcpPool({ cpbRoot, hubRoot, env: runtimeEnv }),
    getArtifactIndex: broker
      ? broker.getArtifactIndex.bind(broker)
      : (root: string, project: string, jobId: string, opts: LooseRecord = {}) =>
        buildArtifactIndex(root, project, jobId, { ...opts, dataRoot: runtimeDataRoot }),
    providerServices: {
      assertProviderAvailable,
      getProviderAdapter,
      delegateMarkProviderUnavailable,
      delegateEnqueueProviderUsage,
      readAgentRoutingMetrics,
    },
  };
}

function envRecord(value: unknown): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  Object.assign(record, recordValue(value));
  return record;
}

export async function runJobWithServices(opts: LooseRecord) {
  const {
    cpbRoot,
    project,
    sourcePath: explicitSourcePath,
    hubRoot: explicitHubRoot,
    workerBrokerClient,
    ...jobOptions
  } = opts;
  const broker = workerBrokerClient instanceof WorkerBrokerClient ? workerBrokerClient : null;
  await mkdir(cpbRoot, { recursive: true });
  const { sourcePath: resolvedSourcePath, hubRoot: resolvedHubRoot, projectRuntimeRoot } = broker
    ? await resolveSourcePathFromBroker(broker, project, explicitHubRoot)
    : await resolveSourcePath(cpbRoot, project, explicitHubRoot);
  const hubRoot = explicitHubRoot || resolvedHubRoot;
  const sourcePath = explicitSourcePath || resolvedSourcePath;
  if (!projectRuntimeRoot) {
    throw new Error(`project runtime root required for project '${project}'`);
  }
  const jobId = typeof opts.jobId === "string" ? opts.jobId : null;
  const env = {
    ...envRecord(jobOptions.env || process.env),
    CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot,
    ...(sourcePath ? { CPB_PROJECT_PATH_OVERRIDE: sourcePath } : {}),
  };
  const services = buildServices(cpbRoot, { hubRoot, env, dataRoot: projectRuntimeRoot, workerBrokerClient: broker });
  const callerProvidedProviderServices = jobOptions.providerServices !== undefined;
  return runJob({
    ...jobOptions,
    cpbRoot,
    project,
    hubRoot,
    dataRoot: projectRuntimeRoot,
    env,
    sourcePath,
    routing: opts.routing || null,
    agentAvailability: opts.agentAvailability || null,
    agentHealth: opts.agentHealth || null,
    teamPolicy: opts.teamPolicy || null,
    // Inject the existing process registry so verify hard-gate child PIDs are
    // persisted to {dataRoot}/processes/ (same store worker-supervisor uses).
    // opts.signal (AbortSignal) flows through ...opts above into ctx, reaching
    // runVerify → runHardGates → runCommandTree without extra plumbing.
    processHooks: jobId ? {
      registerChild: (pid: number) => addChildPid(cpbRoot, jobId, pid, { dataRoot: projectRuntimeRoot }),
    } : undefined,
    ...services,
    providerServices: callerProvidedProviderServices ? recordValue(jobOptions.providerServices) : services.providerServices,
  });
}

async function resolveSourcePathFromBroker(broker: WorkerBrokerClient, project: string, hubRoot: string | null = null) {
  const registered = await broker.getProject(project);
  return {
    sourcePath: typeof registered?.sourcePath === "string" ? registered.sourcePath : null,
    hubRoot,
    projectRuntimeRoot: typeof registered?.projectRuntimeRoot === "string" ? registered.projectRuntimeRoot : null,
  };
}

async function resolveSourcePath(cpbRoot: string, project: string, hubRootOverride: string | null = null) {
  try {
    const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
    const registered = await getProject(hubRoot, project);
    return { sourcePath: registered?.sourcePath || null, hubRoot, projectRuntimeRoot: registered?.projectRuntimeRoot || null };
  } catch {
    return { sourcePath: null, hubRoot: null, projectRuntimeRoot: null };
  }
}
