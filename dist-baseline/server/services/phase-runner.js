import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildLocator, locatorEnvelope, projectExists } from "./phase-locator.js";
import { getJob, listJobsFromIndex } from "./job/job-store.js";
import { getWorkflow, roleForPhase as workflowRoleForPhase } from "./workflow-definition.js";
import { checkPermission } from "./permission-matrix.js";
import { resolveProjectDataRoot } from "./runtime.js";
const PARENT_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function roleForBridge(scriptPath) {
    const base = path.basename(scriptPath);
    if (base === "planner.sh")
        return "planner";
    if (base === "executor.sh")
        return "executor";
    if (base === "repairer.sh")
        return "repairer";
    if (base === "verifier.sh")
        return "verifier";
    if (base === "reviewer.sh")
        return "reviewer";
    return null;
}
export function phaseRole(phase) {
    switch (phase) {
        case "plan": return "planner";
        case "execute": return "executor";
        case "verify": return "verifier";
        case "review": return "reviewer";
        case "repair": return "repairer";
        default: return null;
    }
}
export async function validatePhaseInputs(cpbRoot, project, jobId, phase) {
    const errors = [];
    if (!project || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(project)) {
        errors.push(`invalid project name: ${project}`);
    }
    if (!jobId || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) {
        errors.push(`invalid job ID: ${jobId}`);
    }
    if (!phase || typeof phase !== "string") {
        errors.push(`invalid phase: ${phase}`);
    }
    if (errors.length > 0)
        return { valid: false, errors };
    const exists = await projectExists(cpbRoot, project);
    if (!exists) {
        errors.push(`project not found: ${project}`);
    }
    let dataRoot = null;
    try {
        dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
    }
    catch (err) {
        errors.push(err?.message || `project runtime root required for project: ${project}`);
    }
    const job = dataRoot ? await getJob(cpbRoot, project, jobId, { dataRoot }) : null;
    if (!job?.jobId) {
        errors.push(`job not found: ${jobId}`);
    }
    return { valid: errors.length === 0, errors };
}
export async function checkPhasePermissions(cpbRoot, project, jobId, phase, targetPath, action) {
    const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: process.env.CPB_HUB_ROOT });
    const job = await getJob(cpbRoot, project, jobId, { dataRoot });
    const workflow = getWorkflow(job?.workflow);
    const role = workflowRoleForPhase(workflow, phase) || phaseRole(phase);
    if (!role)
        return { allowed: true };
    const sourcePath = job?.worktree || process.env.CPB_PROJECT_PATH_OVERRIDE || null;
    return checkPermission(role, action, targetPath, cpbRoot, project, { sourcePath, jobId, dataRoot });
}
async function fileExists(file) {
    try {
        return (await stat(file)).isFile();
    }
    catch {
        return false;
    }
}
function requireParentPlanDataRoot(dataRoot) {
    if (!dataRoot) {
        throw new Error("project runtime root required for parent plan cache");
    }
    return path.resolve(dataRoot);
}
export function parentPlanStoreDir(_cpbRoot, project, { dataRoot } = {}) {
    return path.join(requireParentPlanDataRoot(dataRoot), "plan-cache", project);
}
export function parentPlanRecordPath(cpbRoot, project, planCacheKey, opts = {}) {
    return path.join(parentPlanStoreDir(cpbRoot, project, opts), `${planCacheKey}.json`);
}
async function writeAtomic(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
}
export async function readParentPlanRecord(cpbRoot, project, planCacheKey, opts = {}) {
    if (!planCacheKey)
        return null;
    const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
    try {
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export async function writeParentPlanRecord(cpbRoot, project, planCacheKey, record, opts = {}) {
    if (!planCacheKey)
        throw new Error("planCacheKey is required");
    const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
    await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    return { ...record, cachePath: file };
}
function normalizeWords(text = "") {
    return text.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
}
function wordOverlap(a, b) {
    const sa = new Set(normalizeWords(a));
    const sb = new Set(normalizeWords(b));
    if (sa.size === 0 || sb.size === 0)
        return 0;
    let common = 0;
    for (const word of sa)
        if (sb.has(word))
            common++;
    return common / Math.min(sa.size, sb.size);
}
async function planFileExists(cpbRoot, project, planId, { dataRoot } = {}) {
    try {
        if (!dataRoot)
            throw new Error("project runtime root required for parent plan artifact lookup");
        await access(path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${planId}.md`));
        return true;
    }
    catch {
        return false;
    }
}
function stableParentPlanPayload({ project, task, sourceContext = {} } = {}) {
    const planGroupId = sourceContext?.planGroupId || null;
    if (planGroupId) {
        return {
            project,
            planGroupId,
            source: {
                repo: sourceContext?.repo || null,
                issueNumber: sourceContext?.issueNumber ?? null,
            },
        };
    }
    return {
        project,
        task: String(task || "").trim().replace(/\s+/g, " "),
        source: {
            repo: sourceContext?.repo || null,
            issueNumber: sourceContext?.issueNumber ?? null,
            issueUrl: sourceContext?.issueUrl || null,
            sourceFingerprint: sourceContext?.sourceFingerprint || null,
            specHash: sourceContext?.specHash || null,
            designHash: sourceContext?.designHash || null,
            tasksHash: sourceContext?.tasksHash || null,
            taskId: sourceContext?.taskId || null,
            parentPlanId: sourceContext?.parentPlanId || null,
        },
    };
}
function explicitParentPlanId(sourceContext = {}) {
    const value = sourceContext?.parentPlanId || null;
    return value ? String(value).replace(/^plan-/, "") : null;
}
function hashPayload(payload) {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function planArtifactPath(_cpbRoot, _project, planArtifact, { dataRoot } = {}) {
    if (!dataRoot)
        throw new Error("project runtime root required for parent plan artifact path");
    const artifact = String(planArtifact || "").replace(/^plan-/, "");
    return path.join(path.resolve(dataRoot), "wiki", "inbox", `plan-${artifact}.md`);
}
async function artifactExists(filePath) {
    try {
        const info = await stat(filePath);
        return info.isFile() && info.size > 0;
    }
    catch {
        return false;
    }
}
export function parentPlanCacheIdentity({ project, task, sourceContext = {} } = {}) {
    const payload = stableParentPlanPayload({ project, task, sourceContext });
    const digest = hashPayload(payload);
    return {
        planGroupId: `plan-group-${digest.slice(0, 12)}`,
        planCacheKey: digest.slice(0, 16),
        payload,
    };
}
async function resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot } = {}) {
    return await resolveProjectDataRoot(cpbRoot, project, { dataRoot, hubRoot });
}
export async function resolveParentPlanCache(cpbRoot, { project, task, sourceContext = {}, dataRoot, hubRoot } = {}) {
    if (!project)
        throw new Error("project is required");
    const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot });
    const identity = parentPlanCacheIdentity({ project, task, sourceContext });
    const file = parentPlanRecordPath(cpbRoot, project, identity.planCacheKey, { dataRoot: resolvedDataRoot });
    const cached = await readParentPlanRecord(cpbRoot, project, identity.planCacheKey, { dataRoot: resolvedDataRoot });
    const explicitPlanId = explicitParentPlanId(sourceContext);
    const planId = cached?.parentPlanId || cached?.planId || explicitPlanId || null;
    const planArtifact = cached?.planArtifact || (planId ? `plan-${planId}` : null);
    const artifactPath = planArtifact ? planArtifactPath(cpbRoot, project, planArtifact, { dataRoot: resolvedDataRoot }) : null;
    const cacheHit = Boolean(planId && artifactPath && await artifactExists(artifactPath));
    return {
        schemaVersion: 1,
        source: "parent_plan_cache",
        project,
        dataRoot: resolvedDataRoot,
        task,
        ...identity,
        cachePath: file,
        cacheHit,
        parentPlanId: cacheHit ? planId : null,
        reusedPlanId: cacheHit ? planId : null,
        reusedPlanArtifact: cacheHit ? planArtifact : null,
        mergedPlanIds: cacheHit ? [...new Set([planId, ...(cached?.mergedPlanIds || [])])] : [],
        stale: Boolean(cached && !cacheHit),
        cachedAt: cached?.updatedAt || null,
    };
}
export async function writeParentPlanCache(cpbRoot, { project, task, sourceContext = {}, dataRoot, hubRoot, planGroupId = null, planCacheKey = null, planId, planArtifact = null, mergedPlanIds = [], } = {}) {
    if (!project)
        throw new Error("project is required");
    if (!planId)
        throw new Error("planId is required");
    const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot });
    const identity = planCacheKey && planGroupId
        ? { planGroupId, planCacheKey, payload: stableParentPlanPayload({ project, task, sourceContext }) }
        : parentPlanCacheIdentity({ project, task, sourceContext });
    const artifact = planArtifact || `plan-${planId}`;
    const record = {
        schemaVersion: 1,
        source: "parent_plan_cache",
        project,
        task,
        planGroupId: identity.planGroupId,
        planCacheKey: identity.planCacheKey,
        parentPlanId: String(planId),
        planId: String(planId),
        planArtifact: artifact,
        planArtifactPath: planArtifactPath(cpbRoot, project, artifact, { dataRoot: resolvedDataRoot }),
        mergedPlanIds: [...new Set([String(planId), ...mergedPlanIds.filter(Boolean).map(String)])],
        payload: identity.payload,
        updatedAt: new Date().toISOString(),
    };
    const stored = await writeParentPlanRecord(cpbRoot, project, identity.planCacheKey, record, { dataRoot: resolvedDataRoot });
    return {
        ...stored,
        dataRoot: resolvedDataRoot,
        cacheHit: true,
        planCacheKey: record.planCacheKey,
        parentPlanId: record.parentPlanId,
        reusedPlanId: record.planId,
        reusedPlanArtifact: record.planArtifact,
    };
}
function parentPlanHitResult(identity, { source, planId, artifact, parentJobId = null, cachedAt = null }) {
    return {
        schemaVersion: 2,
        cacheHit: true,
        source,
        project: identity.payload.project,
        task: identity.payload.task,
        ...identity,
        parentPlanId: planId,
        reusedPlanId: planId,
        reusedPlanArtifact: artifact,
        mergedPlanIds: [planId],
        parentJobId,
        stale: false,
        cachedAt,
    };
}
function parentPlanMissResult(identity, stale = false, cachedAt = null) {
    return {
        schemaVersion: 2,
        cacheHit: false,
        source: null,
        project: identity.payload.project,
        task: identity.payload.task,
        ...identity,
        parentPlanId: null,
        reusedPlanId: null,
        reusedPlanArtifact: null,
        mergedPlanIds: [],
        parentJobId: null,
        stale,
        cachedAt,
    };
}
async function findParentPlanJobIndexHit(cpbRoot, project, { sourceContext, task, dataRoot } = {}) {
    const allJobs = await listJobsFromIndex(cpbRoot, { dataRoot });
    const cutoff = Date.now() - PARENT_PLAN_MAX_AGE_MS;
    const candidates = allJobs
        .filter((job) => job.project === project)
        .filter((job) => job.completedPhases?.includes("plan"))
        .filter((job) => job.artifacts?.plan)
        .filter((job) => job.status !== "cancelled")
        .filter((job) => {
        const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
        return !Number.isNaN(updatedAt) && updatedAt >= cutoff;
    })
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    if (candidates.length === 0)
        return null;
    const issueNumber = sourceContext?.issueNumber;
    if (issueNumber) {
        for (const job of candidates) {
            const jobIssue = job.sourceContext?.issueNumber;
            if (jobIssue && String(jobIssue) === String(issueNumber)) {
                const planId = job.artifacts.plan.replace(/^plan-/, "");
                if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
                    return { planId, parentJobId: job.jobId, source: "same_issue" };
                }
            }
        }
    }
    for (const job of candidates) {
        const overlap = wordOverlap(task || "", job.task || "");
        if (overlap >= 0.5) {
            const planId = job.artifacts.plan.replace(/^plan-/, "");
            if (await planFileExists(cpbRoot, project, planId, { dataRoot })) {
                return { planId, parentJobId: job.jobId, source: "task_overlap" };
            }
        }
    }
    return null;
}
export async function resolveParentPlan(cpbRoot, { project, task, sourceContext = {}, dataRoot, hubRoot } = {}) {
    if (!project)
        throw new Error("project is required");
    const resolvedDataRoot = await resolvePlanCacheDataRoot(cpbRoot, project, { dataRoot, hubRoot });
    const identity = parentPlanCacheIdentity({ project, task, sourceContext });
    const explicitPlanId = explicitParentPlanId(sourceContext);
    if (explicitPlanId) {
        const artifact = `plan-${explicitPlanId}`;
        if (await planFileExists(cpbRoot, project, explicitPlanId, { dataRoot: resolvedDataRoot })) {
            return parentPlanHitResult(identity, { source: "explicit", planId: explicitPlanId, artifact });
        }
    }
    const cached = await readParentPlanRecord(cpbRoot, project, identity.planCacheKey, { dataRoot: resolvedDataRoot });
    const cachedPlanId = cached?.parentPlanId || cached?.planId || null;
    if (cachedPlanId) {
        const artifact = cached?.planArtifact || `plan-${cachedPlanId}`;
        if (await planFileExists(cpbRoot, project, cachedPlanId, { dataRoot: resolvedDataRoot })) {
            return parentPlanHitResult(identity, {
                source: "cache",
                planId: cachedPlanId,
                artifact,
                cachedAt: cached?.updatedAt || null,
            });
        }
    }
    const indexHit = await findParentPlanJobIndexHit(cpbRoot, project, { sourceContext, task, dataRoot: resolvedDataRoot });
    if (indexHit) {
        const artifact = `plan-${indexHit.planId}`;
        return parentPlanHitResult(identity, {
            source: indexHit.source,
            planId: indexHit.planId,
            artifact,
            parentJobId: indexHit.parentJobId,
        });
    }
    return parentPlanMissResult(identity, Boolean(cached), cached?.updatedAt || null);
}
function runChild(command, args, cwd, options = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const stdoutChunks = [];
        function finish(result) {
            if (settled)
                return;
            settled = true;
            resolve(result);
        }
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env: options.env || process.env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (err) {
            finish({ exitCode: 1, stdout: "", error: err });
            return;
        }
        child.stdout.on("data", (chunk) => {
            stdoutChunks.push(chunk);
            if (options.onOutput)
                options.onOutput(chunk.toString("utf8"));
        });
        child.stderr.on("data", (chunk) => {
            process.stderr.write(chunk);
        });
        child.on("error", (err) => finish({ exitCode: 1, stdout: "", error: err }));
        child.on("close", (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString("utf8");
            finish({ exitCode: code ?? 1, stdout });
        });
    });
}
export async function dispatchPhase(cpbRoot, { project, jobId, phase, script, scriptArgs, executorRoot, env } = {}) {
    const validation = await validatePhaseInputs(cpbRoot, project, jobId, phase);
    if (!validation.valid) {
        return { exitCode: 1, error: new Error(validation.errors.join("; ")), envelope: null };
    }
    const locator = await buildLocator(cpbRoot, project, jobId, { phase, executorRoot });
    const envelope = locatorEnvelope(locator);
    const resolvedExecutorRoot = executorRoot ? path.resolve(executorRoot) : path.resolve(cpbRoot);
    const bridgeScript = path.isAbsolute(script)
        ? script
        : path.join(resolvedExecutorRoot, script);
    const jobRunner = path.resolve(resolvedExecutorRoot, "bridges", "job-runner.js");
    if (!await fileExists(jobRunner)) {
        return {
            exitCode: 1,
            error: new Error(`job-runner not found: ${jobRunner}`),
            envelope,
        };
    }
    const runnerArgs = [
        jobRunner,
        "--cpb-root", cpbRoot,
        "--project", project,
        "--job-id", jobId,
        "--phase", phase,
        "--script", bridgeScript,
        "--",
        ...(scriptArgs || []),
    ];
    const result = await runChild("node", runnerArgs, cpbRoot, { env: env || process.env });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        error: result.error || null,
        envelope,
    };
}
export async function runPhase(cpbRoot, options) {
    return dispatchPhase(cpbRoot, options);
}
export async function runPhaseFromLocator(locator, script, scriptArgs) {
    const result = await dispatchPhase(locator.cpbRoot, {
        project: locator.project,
        jobId: locator.jobId,
        phase: locator.phase,
        script,
        scriptArgs,
        executorRoot: locator.executorRoot,
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        error: result.error,
        locator,
    };
}
export function extractArtifactId(stdout, prefix) {
    const lower = prefix.toLowerCase().replace(/s$/, "");
    const pattern = new RegExp(`^${prefix}: .*${lower}-(\\d+)\\.md$`, "mi");
    const match = stdout.match(pattern);
    if (match)
        return match[1];
    const genericPattern = new RegExp(`^${prefix}: .*/(?:${lower}|${prefix})-(\\d+)\\.md$`, "mi");
    const genericMatch = stdout.match(genericPattern);
    return genericMatch ? genericMatch[1] : null;
}
export function extractPlanId(stdout) {
    return extractArtifactId(stdout, "Plan");
}
export function extractDeliverableId(stdout) {
    return extractArtifactId(stdout, "Deliverable");
}
