// @ts-nocheck
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { readEventsReadOnly, materializeJob } from "./event-store.js";
import { buildArtifactIndex } from "./artifact-index.js";
import { parseVerdictEnvelope } from "../../core/workflow/verdict.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 };
  } catch (err) {
    if (!allowFailure) throw err;
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
    };
  }
}

async function getDiff(worktreePath, sourceHead) {
  if (!sourceHead) return "";
  const result = await runGit(worktreePath, ["diff", sourceHead, "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getDiffStat(worktreePath, sourceHead) {
  if (!sourceHead) return "";
  const result = await runGit(worktreePath, ["diff", "--stat", sourceHead, "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getChangedFiles(worktreePath, sourceHead) {
  if (!sourceHead) return [];
  const result = await runGit(worktreePath, ["diff", "--name-only", sourceHead, "HEAD"], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

async function getUncommittedDiff(worktreePath) {
  const result = await runGit(worktreePath, ["diff", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getCurrentHead(repoPath) {
  const result = await runGit(repoPath, ["rev-parse", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function getLog(worktreePath, sourceHead, maxCount = 20) {
  if (!sourceHead) return [];
  const result = await runGit(worktreePath, [
    "log", "--oneline", `${sourceHead}..HEAD`, `--max-count=${maxCount}`,
  ], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function buildReviewBundle(cpbRoot, project, jobId, {
  entry = null,
  job = null,
  sourcePath = null,
  worktreePath = null,
  dataRoot = null,
  wikiDir = null,
} = {}) {
  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });
  const jobState = materializeJob(events);

  const worktree = worktreePath || jobState.worktree || job?.worktree || null;
  const baseBranch = jobState.worktreeBaseBranch || job?.worktreeBaseBranch || "main";
  const branch = jobState.worktreeBranch || job?.worktreeBranch || null;

  const artifactIndex = await buildArtifactIndex(cpbRoot, project, jobId, { events, dataRoot, wikiDir });

  const planArtifact = artifactIndex.entries.find((e) => e.kind === "plan" && !e.broken);
  const deliverableArtifact = artifactIndex.entries.find((e) => e.kind === "deliverable" && !e.broken);
  const verdictArtifact = [...artifactIndex.entries].reverse().find((e) => e.kind === "verdict" && !e.broken);
  const reviewArtifact = artifactIndex.entries.find((e) => e.kind === "review" && !e.broken);
  const promptAudit = artifactIndex.entries
    .filter((e) => e.kind === "prompt")
    .map((e) => ({
      id: e.id,
      phase: e.phase || null,
      path: e.path,
      sha256: e.sha256,
      producerAgent: e.producerAgent || null,
      broken: e.broken,
      reason: e.reason || null,
    }));

  let planContent = null;
  if (planArtifact) {
    try { planContent = await readFile(planArtifact.path, "utf8"); } catch {}
  }

  let deliverableContent = null;
  if (deliverableArtifact) {
    try { deliverableContent = await readFile(deliverableArtifact.path, "utf8"); } catch {}
  }

  let verdictContent = null;
  let verdictParsed = null;
  if (verdictArtifact) {
    try {
      verdictContent = await readFile(verdictArtifact.path, "utf8");
      verdictParsed = parseVerdictEnvelope(verdictContent);
    } catch {}
  }

  let reviewContent = null;
  if (reviewArtifact) {
    try { reviewContent = await readFile(reviewArtifact.path, "utf8"); } catch {}
  }

  let diffEvidence = null;
  let diffStat = null;
  let changedFiles = [];
  let commitLog = [];
  let uncommittedDiff = null;

  if (worktree) {
    const sourceHead = sourcePath ? await getCurrentHead(sourcePath) : null;
    const wtHead = await getCurrentHead(worktree);
    const effectiveSourceHead = sourceHead || (wtHead ? `${wtHead}~1` : null);

    [diffEvidence, diffStat, changedFiles, commitLog, uncommittedDiff] = await Promise.all([
      getDiff(worktree, effectiveSourceHead),
      getDiffStat(worktree, effectiveSourceHead),
      getChangedFiles(worktree, effectiveSourceHead),
      getLog(worktree, effectiveSourceHead),
      getUncommittedDiff(worktree),
    ]);
  }

  const timeline = events.map((ev) => ({
    type: ev.type,
    ts: ev.ts || null,
    phase: ev.phase || null,
    agent: ev.agent || null,
    status: ev.status || null,
  }));

  const metadata = entry?.metadata || {};
  const taskDescription = entry?.description || jobState.task || job?.task || null;

  const bundle = {
    schemaVersion: 1,
    bundleType: "local_review",
    generatedAt: new Date().toISOString(),
    project,
    jobId,

    request: {
      task: taskDescription,
      workflow: metadata.workflow || jobState.workflow || "standard",
      planMode: metadata.planMode || jobState.planMode || "full",
      source: metadata.source || "cli",
      actor: metadata.actor || null,
      requestedAt: metadata.requestedAt || jobState.createdAt || null,
    },

    status: {
      jobStatus: jobState.status,
      completedPhases: jobState.completedPhases,
      failureCode: jobState.failureCode || null,
      failurePhase: jobState.failurePhase || null,
    },

    evidence: {
      plan: planContent ? { path: planArtifact?.path || null, content: planContent } : null,
      deliverable: deliverableContent ? { path: deliverableArtifact?.path || null, content: deliverableContent } : null,
      verdict: verdictParsed || (verdictContent ? { raw: verdictContent } : null),
      review: reviewContent || null,
      diff: diffEvidence || null,
      diffStat: diffStat || null,
      uncommittedDiff: uncommittedDiff || null,
      changedFiles,
      commitLog,
    },

    git: {
      worktree,
      branch,
      baseBranch,
      sourcePath: sourcePath || null,
    },

    timeline,

    dw: buildDwSection(jobState),

    promptAudit,

    links: {
      eventLog: `events/${project}/${jobId}.jsonl`,
      artifacts: artifactIndex.entries.map((e) => ({
        kind: e.kind,
        phase: e.phase || null,
        path: e.path,
        sha256: e.sha256,
        broken: e.broken,
      })),
    },
  };

  return bundle;
}

export async function writeReviewBundle(outputDir, bundle) {
  const slug = `${bundle.project}-${bundle.jobId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${slug}-review-bundle.json`;
  const filePath = path.join(outputDir, fileName);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
  return filePath;
}

/**
 * Build the DW (Dynamic Workflow) evidence section from materialized job state.
 *
 * @param {object} jobState — materialized job from event-store
 * @returns {object} dw section for the review bundle
 */
function buildDwSection(jobState) {
  const dag = jobState.workflowDag;
  const dagNodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const dagEdges = Array.isArray(dag?.edges) ? dag.edges : [];

  return {
    riskMap: jobState.riskMap ?? null,
    workflowDag: dag
      ? {
          name: dag.name ?? jobState.workflow ?? null,
          nodeCount: dagNodes.length,
          edgeCount: dagEdges.length,
          nodes: dagNodes.map((n) => ({
            id: n.id ?? null,
            phase: n.phase ?? n.id ?? null,
            role: n.role ?? null,
          })),
        }
      : null,
    dynamicAgentPlan: jobState.dynamicAgentPlan ?? null,
    verdict: jobState.artifacts?.verdict
      ? { status: jobState.verdict ?? null, artifact: jobState.artifacts.verdict }
      : null,
    adversarialVerdict: jobState.adversarialVerdict ?? null,
    completionGate: jobState.completionGate ?? null,
  };
}

export function reviewBundleDir(hubRoot, project, jobId) {
  return path.join(hubRoot, "review-bundles", project);
}

export function reviewBundleDwContract() {
  return {
    includesRiskMap: true,
    includesWorkflowDag: true,
    includesDynamicAgentPlan: true,
    includesAdversarialVerdict: true,
    includesCompletionGate: true,
  };
}
