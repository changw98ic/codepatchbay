/**
 * Review Dispatch — extracted session dispatch, analysis, and cancellation logic.
 *
 * Centralizes the business logic that was previously inline in review routes.
 * Routes become thin HTTP adapters that delegate here.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { execFile } from "child_process";
import { enqueue } from "./hub-queue.js";
import { makeJobId } from "./job-store.js";
import { getSession, updateSession } from "./review-session.js";
import { buildChildEnv } from "./secret-policy.js";
import { resolveHubRoot, getProject } from "./hub-registry.js";
import { resolveProjectDataRoot } from "./runtime-context.js";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DISPATCH_LOCK_MAX_ATTEMPTS = 100;
const DISPATCH_LOCK_DELAY_MS = 10;

function reviewControlRoot(cpbRoot, hubRoot = null) {
  return path.resolve(hubRoot || process.env.CPB_HUB_ROOT || cpbRoot);
}

function reviewStorageOptions(cpbRoot, hubRoot = null) {
  return { hubRoot: reviewControlRoot(cpbRoot, hubRoot) };
}

function dispatchLockDir(cpbRoot, sessionId, hubRoot = null) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  return path.join(reviewControlRoot(cpbRoot, hubRoot), "reviews", `.lock-dispatch-${sessionId}`);
}

async function withDispatchSessionLock(cpbRoot, sessionId, hubRoot, fn) {
  const lockDir = dispatchLockDir(cpbRoot, sessionId, hubRoot);
  await mkdir(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST" || attempt >= DISPATCH_LOCK_MAX_ATTEMPTS) {
        throw err?.code === "EEXIST"
          ? new Error(`review dispatch lock busy: ${sessionId}`)
          : err;
      }
      await new Promise((resolve) => setTimeout(resolve, DISPATCH_LOCK_DELAY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

function gitExec(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

async function worktreePathFor(cpbRoot, project, jobId, hubRoot) {
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot });
  return path.join(dataRoot, "worktrees", `${jobId}-pipeline`);
}

async function projectSourcePathFor(hubRoot, project) {
  let registered = null;
  try {
    registered = await getProject(hubRoot, project);
  } catch {
    registered = null;
  }
  return registered?.sourcePath || null;
}

/**
 * Dispatch a review session to the hub queue.
 * Shared by approve and auto-approve routes.
 */
export async function dispatchSession(cpbRoot, sessionId, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
  const storageOptions = reviewStorageOptions(cpbRoot, hubRoot);
  return withDispatchSessionLock(cpbRoot, sessionId, hubRoot, async () => {
    const session = await getSession(cpbRoot, sessionId, storageOptions);
    if (!session) return { ok: false, error: "session_not_found" };

    if (session.status === "dispatched" && session.jobId) {
      return {
        ok: true,
        dispatched: true,
        sessionId: session.sessionId,
        taskId: session.queueEntryId || session.jobId,
        jobId: session.jobId,
        session,
        project: session.project,
        note: "already_dispatched",
      };
    }

    if (session.status !== "user_review") {
      return {
        ok: false,
        error: "invalid_state",
        status: session.status,
        note: "invalid_state_for_dispatch",
      };
    }

    const jobId = makeJobId();
    const dispatchKey = `review:${session.sessionId}`;

    let registered;
    try { registered = await getProject(hubRoot, session.project); } catch { registered = null; }

    const entry = await enqueue(hubRoot, {
      projectId: session.project,
      sourcePath: registered?.sourcePath || null,
      sessionId: session.sessionId,
      priority: "P1",
      description: session.intent,
      type: "review_dispatch",
      metadata: {
        source: "review",
        reviewSessionId: session.sessionId,
        queueDedupeKey: dispatchKey,
        jobId,
        workflow: "standard",
        autoFinalize: true,
        requestedAt: new Date().toISOString(),
      },
    });

    const dispatchedJobId = entry.metadata?.jobId || jobId;
    const wtPath = await worktreePathFor(cpbRoot, session.project, dispatchedJobId, hubRoot);
    const updated = await updateSession(cpbRoot, session.sessionId, {
      status: "dispatched",
      userVerdict: "approved",
      jobId: dispatchedJobId,
      queueEntryId: entry.id,
      worktreePath: wtPath,
      idempotency: {
        ...(session.idempotency || {}),
        dispatchKey,
      },
    }, storageOptions);

    return {
      ok: true,
      sessionId: session.sessionId,
      taskId: entry.id,
      jobId: dispatchedJobId,
      session: updated,
      project: session.project,
    };
  });
}

/**
 * Auto-approve path: handles already-dispatched sessions idempotently.
 */
export async function autoApproveSession(cpbRoot, sessionId, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
  const storageOptions = reviewStorageOptions(cpbRoot, hubRoot);
  const session = await getSession(cpbRoot, sessionId, storageOptions);
  if (!session) return { ok: false, error: "session_not_found" };

  if (!["dispatched", "user_review"].includes(session.status)) {
    return {
      ok: false,
      error: "invalid_state",
      status: session.status,
      note: "invalid_state_for_auto_approve",
    };
  }

  return dispatchSession(cpbRoot, sessionId, { hubRoot: hubRootOverride });
}

/**
 * Cancel a review session.
 */
export async function cancelReviewDispatch(cpbRoot, sessionId, reason, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
  const storageOptions = reviewStorageOptions(cpbRoot, hubRoot);
  const session = await getSession(cpbRoot, sessionId, storageOptions);
  if (!session) return { ok: false, error: "session_not_found" };

  const updated = await updateSession(cpbRoot, sessionId, {
    status: "cancelled",
    detail: reason || "cancelled",
  }, { ...storageOptions, skipTransitionCheck: true });

  return { ok: true, sessionId, session: updated, project: session.project };
}

/**
 * Run ACP analysis on a review session.
 */
export async function analyzeSession(cpbRoot, sessionId, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
  const session = await getSession(cpbRoot, sessionId, reviewStorageOptions(cpbRoot, hubRoot));
  if (!session) return { ok: false, error: "session_not_found" };

  const sections = [];
  if (session.intent) sections.push(`## Intent\n${session.intent}`);
  if (session.research?.codex) sections.push(`## Codex Research\n${session.research.codex.slice(0, 3000)}`);
  if (session.research?.claude) sections.push(`## Claude Research\n${session.research.claude.slice(0, 3000)}`);
  if (session.plan) sections.push(`## Implementation Plan\n${session.plan.slice(0, 4000)}`);

  if (session.reviews && session.reviews.length > 0) {
    const latest = session.reviews[session.reviews.length - 1];
    if (latest.codex) sections.push(`## Codex Review (Round ${latest.round})\n${latest.codex.slice(0, 3000)}`);
    if (latest.claude) sections.push(`## Claude Review (Round ${latest.round})\n${latest.claude.slice(0, 3000)}`);
    const issues = [
      ...(latest.codexIssues || []).map(i => `[Codex P${i.severity}] ${i.message || "issue"}`),
      ...(latest.claudeIssues || []).map(i => `[Claude P${i.severity}] ${i.message || "issue"}`),
    ];
    if (issues.length > 0) sections.push(`## Issues Found\n${issues.join("\n")}`);
  }

  if (sections.length === 0) {
    return {
      ok: true,
      summary: "No content available yet for analysis.",
      changes: [],
      risks: [],
      recommendation: `Session is in ${session.status} state.`,
    };
  }

  const prompt = `You are a code review analyst. Analyze the following review session and produce a JSON object.

Project: ${session.project}
Status: ${session.status}

${sections.join("\n\n")}

Respond with ONLY a JSON object (no markdown fences) with these fields:
- "summary": one paragraph explaining what this review is about
- "changes": array of strings describing key changes proposed
- "risks": array of strings describing risks or concerns found
- "recommendation": string with clear approve/reject advice and reasoning`;

  const scriptPath = path.join(cpbRoot, "server", "services", "acp-client-core.js");
  const env = buildChildEnv(
    process.env,
    { CPB_ROOT: cpbRoot, CPB_ACP_TIMEOUT_MS: "90000" },
    { agent: "claude" },
  );

  const acpResult = await new Promise((resolve) => {
    const child = spawn("node", [scriptPath, "--agent", "claude", "--cwd", cpbRoot], {
      cwd: cpbRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => { child.kill(); resolve({ error: "Analysis timed out" }); }, 120000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        resolve({ error: stderr.slice(-500) || `ACP exited with code ${code}` });
      } else {
        resolve({ output: stdout });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: err.message });
    });
  });

  const resultRecord = acpResult as Record<string, any>;
  if (resultRecord.error) {
    return { ok: false, summary: `Analysis failed: ${resultRecord.error}`, changes: [], risks: [], recommendation: "Could not complete ACP analysis. Review the session content manually." };
  }

  let parsed = null;
  const rawOutput = resultRecord.output || "";
  const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)```/) || rawOutput.match(/\{[\s\S]*"summary"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    } catch { /* fall through */ }
  }

  if (parsed && parsed.summary) {
    return {
      ok: true,
      summary: parsed.summary,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      recommendation: parsed.recommendation || "",
      raw: rawOutput,
    };
  }

  return {
    ok: true,
    summary: rawOutput.slice(0, 500) || "Analysis produced no output.",
    changes: [],
    risks: [],
    recommendation: "Review the raw analysis output for details.",
    raw: rawOutput,
  };
}

/**
 * Accept a review session — merge worktree branch into main.
 */
export async function acceptSession(cpbRoot, sessionId, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
  const storageOptions = reviewStorageOptions(cpbRoot, hubRoot);
  const session = await getSession(cpbRoot, sessionId, storageOptions);
  if (!session) return { ok: false, error: "session_not_found" };
  if (session.status !== "user_review" && session.status !== "dispatched") {
    return { ok: false, error: "invalid_state", status: session.status };
  }

  let merged = false;
  let mergeError = null;

  if (session.worktreePath || session.jobId) {
    if (!session.worktreePath || !session.jobId) {
      mergeError = "review merge requires both worktreePath and jobId";
    } else {
      const sourcePath = await projectSourcePathFor(hubRoot, session.project);
      if (!sourcePath) {
        mergeError = `project sourcePath missing for review session ${session.sessionId}`;
      } else {
        const branch = `cpb/${session.jobId}-pipeline`;
        try {
          await gitExec(sourcePath, "rev-parse", "--verify", branch);
          await gitExec(sourcePath, "merge", "--no-ff", "-m", `cpb: accept review ${session.sessionId}`, branch);
          merged = true;
          await gitExec(sourcePath, "branch", "-D", branch).catch(() => {});
        } catch (err) {
          mergeError = err.message;
        }
        await gitExec(sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
        await rm(session.worktreePath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  const finalStatus = (!merged && mergeError) ? "merge_failed" : "completed";
  const updated = await updateSession(cpbRoot, session.sessionId, {
    status: finalStatus,
    userVerdict: "accepted",
    merged,
    ...(mergeError && { mergeError }),
  }, storageOptions);

  return {
    ok: true,
    sessionId,
    merged,
    mergeFailed: !merged && Boolean(mergeError),
    status: finalStatus,
    session: updated,
    project: session.project,
  };
}

/**
 * Reject a review session — discard worktree.
 */
export async function rejectSession(cpbRoot, sessionId, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
  const storageOptions = reviewStorageOptions(cpbRoot, hubRoot);
  const session = await getSession(cpbRoot, sessionId, storageOptions);
  if (!session) return { ok: false, error: "session_not_found" };
  if (session.status !== "user_review") {
    return { ok: false, error: "invalid_state", status: session.status };
  }

  if (session.worktreePath) {
    const sourcePath = await projectSourcePathFor(hubRoot, session.project);
    if (sourcePath) {
      await gitExec(sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
    }
    try { await rm(session.worktreePath, { recursive: true, force: true }); } catch {}
  }

  const updated = await updateSession(cpbRoot, session.sessionId, {
    status: "expired",
    userVerdict: "rejected",
  }, storageOptions);

  return { ok: true, sessionId, session: updated, project: session.project };
}
