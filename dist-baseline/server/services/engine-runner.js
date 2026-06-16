import { runJob } from "../../core/engine/run-job.js";
import { mkdir } from "node:fs/promises";
import { createJob, startPhase, completePhase, completeJob, failJob, blockJob } from "./job/job-store.js";
import { appendEvent } from "./event/event-store.js";
import { getManagedAcpPool } from "./acp/acp-pool.js";
import { resolveHubRoot, getProject } from "./hub/hub-registry.js";
import { assertProviderAvailable } from "./provider-quota.js";
import { getProviderAdapter } from "./provider-adapters.js";
import { prepareTask } from "./project/project-loader.js";
import { buildArtifactIndex } from "./job/job-projection.js";
import { addChildPid } from "./infra.js";
import { delegateMarkProviderUnavailable, delegateEnqueueProviderUsage, } from "./quota-delegate-client.js";
function prepareTaskForEnv(env) {
    if (env?.CPB_ACP_FAKE_ACP_COMMAND) {
        return async () => ({
            riskLevel: "low",
            domains: ["test_fixture"],
            highRiskFiles: [],
            safetyBoundaries: [],
            verificationDepth: "standard",
            adversarialRequired: false,
            adversarialFocus: [],
            confidence: "high",
            generatedAt: new Date().toISOString(),
            source: { testFixture: true },
        });
    }
    return prepareTask;
}
export function buildServices(cpbRoot, { hubRoot = null, env = process.env, dataRoot = null } = {}) {
    const withJobOptions = (fn) => dataRoot
        ? (root, project, jobId, opts = {}) => fn(root, project, jobId, { ...opts, dataRoot })
        : fn;
    return {
        createJob: dataRoot
            ? (root, opts = {}) => createJob(root, { ...opts, dataRoot })
            : createJob,
        startPhase: withJobOptions(startPhase),
        completePhase: withJobOptions(completePhase),
        completeJob: dataRoot
            ? (root, project, jobId, opts = {}) => completeJob(root, project, jobId, { ...opts, dataRoot })
            : completeJob,
        failJob: withJobOptions(failJob),
        blockJob: withJobOptions(blockJob),
        appendEvent: dataRoot
            ? (root, project, jobId, event, opts = {}) => {
                if (typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) {
                    throw new Error(`invalid jobId for appendEvent: ${JSON.stringify(jobId)}`);
                }
                return appendEvent(root, project, jobId, event, { ...opts, dataRoot, includeLegacyFallback: false });
            }
            : appendEvent,
        prepareTask: prepareTaskForEnv(env),
        getPool: () => getManagedAcpPool({ cpbRoot, hubRoot, env }),
        getArtifactIndex: (root, project, jobId, opts = {}) => buildArtifactIndex(root, project, jobId, { ...opts, dataRoot }),
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
    await mkdir(cpbRoot, { recursive: true });
    const { sourcePath: resolvedSourcePath, hubRoot: resolvedHubRoot, projectRuntimeRoot } = await resolveSourcePath(cpbRoot, project, explicitHubRoot);
    const hubRoot = explicitHubRoot || resolvedHubRoot;
    if (!projectRuntimeRoot) {
        throw new Error(`project runtime root required for project '${project}'`);
    }
    const env = {
        ...(opts.env || process.env),
        CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot,
    };
    const services = buildServices(cpbRoot, { hubRoot, env, dataRoot: projectRuntimeRoot });
    const callerProvidedProviderServices = opts.providerServices !== undefined;
    return runJob({
        ...opts,
        hubRoot,
        dataRoot: projectRuntimeRoot,
        env,
        sourcePath: explicitSourcePath || resolvedSourcePath,
        routing: opts.routing || null,
        agentAvailability: opts.agentAvailability || null,
        agentHealth: opts.agentHealth || null,
        teamPolicy: opts.teamPolicy || null,
        // Inject the existing process registry so verify hard-gate child PIDs are
        // persisted to {dataRoot}/processes/ (same store worker-supervisor uses).
        // opts.signal (AbortSignal) flows through ...opts above into ctx, reaching
        // runVerify → runHardGates → runCommandTree without extra plumbing.
        processHooks: opts.jobId ? {
            registerChild: (pid) => addChildPid(cpbRoot, opts.jobId, pid, { dataRoot: projectRuntimeRoot }),
        } : undefined,
        ...services,
        providerServices: callerProvidedProviderServices ? opts.providerServices : services.providerServices,
    });
}
async function resolveSourcePath(cpbRoot, project, hubRootOverride = null) {
    try {
        const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
        const registered = await getProject(hubRoot, project);
        return { sourcePath: registered?.sourcePath || null, hubRoot, projectRuntimeRoot: registered?.projectRuntimeRoot || null };
    }
    catch {
        return { sourcePath: null, hubRoot: null, projectRuntimeRoot: null };
    }
}
