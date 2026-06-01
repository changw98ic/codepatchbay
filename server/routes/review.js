import { spawn, execFile } from "child_process";
import path from "path";
import { readFile, rm } from "fs/promises";
import { runtimeDataPath } from "../services/runtime-root.js";
import { broadcast } from "../services/ws-broadcast.js";
import { unregisterTask } from "../services/executor.js";
import { enqueue } from "../services/hub-queue.js";
import { makeJobId } from "../services/job-store.js";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  startSessionResearch,
} from "../services/review-session.js";
import { buildChildEnv } from "../services/secret-policy.js";
import { writeProjectIndex } from "../services/project-index.js";
import { resolveHubRoot, getProject } from "../services/hub-registry.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function gitExec(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

function worktreePathFor(cpbRoot, jobId) {
  return runtimeDataPath(cpbRoot, "worktrees", `${jobId}-pipeline`);
}

const REVIEW_NOTIFY_STATUSES = new Set(["user_review", "dispatched", "expired", "cancelled"]);

export async function reviewRoutes(fastify, opts) {

  const notify = (event) => {
    broadcast(event);
    if (REVIEW_NOTIFY_STATUSES.has(event.status)) {
      fastify.notifBroadcast(event).catch(() => {});
    }
  };

  // Create review session
  fastify.post("/review", async (req) => {
    const { project, intent } = req.body || {};
    if (!project || !SAFE_NAME.test(project)) {
      throw fastify.httpErrors.badRequest("valid project name required");
    }
    if (!intent || typeof intent !== "string" || intent.trim().length < 3) {
      throw fastify.httpErrors.badRequest("intent required (min 3 chars)");
    }

    const session = await createSession(req.cpbRoot, { project, intent: intent.trim() });
    notify({ type: "review:update", sessionId: session.sessionId, status: session.status, project, session });
    return session;
  });

  // List sessions
  fastify.get("/review", async (req) => {
    return listSessions(req.cpbRoot);
  });

  // Get session
  fastify.get("/review/:id", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    return session;
  });

  // Start review cpb (spawns review-dispatch.mjs in background)
  fastify.post("/review/:id/start", async (req) => {
    let session;
    const key = req.headers['idempotency-key'] || `start-${Date.now()}`;
    try {
      session = await startSessionResearch(req.cpbRoot, req.params.id, key);
    } catch (err) {
      if (err.message?.includes("invalid transition") || err.message?.includes("already in status")) {
        throw fastify.httpErrors.conflict(`session not in idle state`);
      }
      if (err.message?.includes("idempotency conflict")) {
        throw fastify.httpErrors.conflict(`session already started with different key`);
      }
      if (err.message?.includes("not found")) {
        throw fastify.httpErrors.notFound("session not found");
      }
      throw err;
    }

    const scriptPath = path.join(req.cpbRoot, "bridges/review-dispatch.mjs");

    const child = spawn("node", [scriptPath, req.cpbRoot, session.sessionId], {
      cwd: req.cpbRoot,
      env: buildChildEnv(process.env, { CPB_ROOT: req.cpbRoot }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (chunk) => process.stdout.write(`[review-dispatch] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[review-dispatch] ${chunk}`));
    child.on("exit", () => { try { unregisterTask(`review:${session.sessionId}`); } catch {} });
    child.unref();

    return { accepted: true, sessionId: session.sessionId };
  });

  // User approves → dispatch pipeline via hub queue
  fastify.post("/review/:id/approve", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    const jobId = makeJobId();
    const wtPath = worktreePathFor(req.cpbRoot, jobId);
    const hubRoot = req.cpbHubRoot || resolveHubRoot(req.cpbRoot);

    let registered;
    try { registered = await getProject(hubRoot, session.project); } catch { registered = null; }

    const entry = await enqueue(hubRoot, {
      projectId: session.project,
      sourcePath: registered?.sourcePath || null,
      priority: "P1",
      description: session.intent,
      type: "review_dispatch",
      metadata: {
        source: "review",
        reviewSessionId: session.sessionId,
        jobId,
        workflow: "standard",
        autoFinalize: true,
        requestedAt: new Date().toISOString(),
      },
    });

    await updateSession(req.cpbRoot, session.sessionId, {
      status: "dispatched",
      userVerdict: "approved",
      jobId,
      worktreePath: wtPath,
    });

    notify({
      type: "review:update",
      sessionId: session.sessionId,
      status: "dispatched",
      jobId: entry.id,
      project: session.project,
      session: await getSession(req.cpbRoot, session.sessionId),
    });

    return { dispatched: true, sessionId: session.sessionId, taskId: entry.id };
  });

  // Internal auto-approve path (used by self-evolve)
  fastify.post("/review/:id/auto-approve", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");

    if (!["dispatched", "user_review"].includes(session.status)) {
      return {
        dispatched: false,
        sessionId: session.sessionId,
        status: session.status,
        note: "invalid_state_for_auto_approve",
      };
    }

    const result = await updateSession(
      req.cpbRoot,
      session.sessionId,
      {
        status: session.status === "dispatched" ? session.status : "dispatched",
        userVerdict: "approved",
      },
      { skipTransitionCheck: true },
    );

    if (result.status === "dispatched" && result.jobId) {
      return {
        dispatched: true,
        sessionId: session.sessionId,
        taskId: result.jobId,
        note: "already_dispatched",
      };
    }

    const jobId = makeJobId();
    const wtPath = worktreePathFor(req.cpbRoot, jobId);
    const hubRoot = req.cpbHubRoot || resolveHubRoot(req.cpbRoot);

    let registered;
    try { registered = await getProject(hubRoot, session.project); } catch { registered = null; }

    const spawnResult = await enqueue(hubRoot, {
      projectId: session.project,
      sourcePath: registered?.sourcePath || null,
      priority: "P1",
      description: session.intent,
      type: "review_dispatch",
      metadata: {
        source: "review",
        reviewSessionId: session.sessionId,
        jobId,
        workflow: "standard",
        autoFinalize: true,
        requestedAt: new Date().toISOString(),
      },
    });

    const refreshed = await updateSession(req.cpbRoot, session.sessionId, {
      ...result,
      jobId,
      worktreePath: wtPath,
      status: "dispatched",
      userVerdict: "approved",
    }, { skipTransitionCheck: true });

    notify({
      type: "review:update",
      sessionId: refreshed.sessionId,
      status: refreshed.status,
      jobId: refreshed.jobId,
      project: refreshed.project,
      session: refreshed,
    });

    return {
      dispatched: true,
      sessionId: session.sessionId,
      taskId: spawnResult.id,
    };
  });

  // User rejects → discard worktree, keep main tree clean
  fastify.post("/review/:id/reject", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    // Clean up worktree if it exists
    if (session.worktreePath) {
      try {
        const projectJson = path.join(req.cpbRoot, "wiki", "projects", session.project, "project.json");
        const meta = JSON.parse(await readFile(projectJson, "utf8"));
        if (meta.sourcePath) {
          await gitExec(meta.sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
        }
      } catch {}
      try { await rm(session.worktreePath, { recursive: true, force: true }); } catch {}
    }

    const updated = await updateSession(req.cpbRoot, session.sessionId, {
      status: "expired",
      userVerdict: "rejected",
    });

    notify({ type: "review:update", sessionId: session.sessionId, status: "expired", project: session.project, session: updated });
    return updated;
  });

  // User accepts → merge worktree branch into main, clean up worktree
  fastify.post("/review/:id/cancel", async (req, reply) => cancelRoute(req, reply, notify));

  fastify.post("/review/:id/accept", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review" && session.status !== "dispatched") {
      throw fastify.httpErrors.conflict(`session not in reviewable state (status: ${session.status})`);
    }

    let merged = false;
    let mergeError = null;
    const hubRoot = req.cpbHubRoot || resolveHubRoot(req.cpbRoot);

    if (session.worktreePath && session.jobId) {
      try {
        const projectJson = path.join(req.cpbRoot, "wiki", "projects", session.project, "project.json");
        const meta = JSON.parse(await readFile(projectJson, "utf8"));
        const sourcePath = meta.sourcePath;
        if (sourcePath) {
          const branch = `cpb/${session.jobId}-pipeline`;
          try {
            await gitExec(sourcePath, "rev-parse", "--verify", branch);
            await gitExec(sourcePath, "merge", "--no-ff", "-m", `cpb: accept review ${session.sessionId}`, branch);
            merged = true;
            await gitExec(sourcePath, "branch", "-D", branch).catch(() => {});

            // Persist project-index after successful merge
            try {
              const gitHead = await gitExec(sourcePath, "rev-parse", "HEAD");
              const currentBranch = await gitExec(sourcePath, "rev-parse", "--abbrev-ref", "HEAD");
              await writeProjectIndex(hubRoot, req.cpbRoot, session.project, {
                state: "merged_indexed",
                branch: currentBranch,
                gitHead,
                indexedFrom: `merge:${session.jobId}`,
                timestamp: new Date().toISOString(),
              });
            } catch { /* best effort index write */ }
          } catch (err) {
            mergeError = err.message;
          }
          await gitExec(sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
          await rm(session.worktreePath, { recursive: true, force: true }).catch(() => {});

          // Persist merge failure status
          if (!merged && mergeError) {
            try {
              const gitHead = await gitExec(sourcePath, "rev-parse", "HEAD").catch(() => null);
              const currentBranch = await gitExec(sourcePath, "rev-parse", "--abbrev-ref", "HEAD").catch(() => null);
              await writeProjectIndex(hubRoot, req.cpbRoot, session.project, {
                state: "merge_failed",
                branch: currentBranch,
                gitHead,
                indexedFrom: `merge:${session.jobId}`,
                timestamp: new Date().toISOString(),
                error: mergeError,
              });
            } catch { /* best effort */ }
          }
        }
      } catch (err) {
        // Best effort merge
      }
    }

    const finalStatus = (!merged && mergeError) ? "merge_failed" : "completed";
    const updated = await updateSession(req.cpbRoot, session.sessionId, {
      status: finalStatus,
      userVerdict: "accepted",
      merged,
      ...(mergeError && { mergeError }),
    });

    notify({ type: "review:update", sessionId: session.sessionId, status: finalStatus, project: session.project, session: updated });
    return { accepted: true, merged, mergeFailed: !merged && Boolean(mergeError), sessionId: session.sessionId };
  });

  // Analyze session for approval (ACP-triggered summary)
  fastify.post("/review/:id/analyze", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");

    // Build context sections from session data
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
      return { summary: "No content available yet for analysis.", changes: [], risks: [], recommendation: `Session is in ${session.status} state.` };
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

    // Run ACP agent to analyze
    const scriptPath = path.join(req.cpbRoot, "runtime", "acp-client.mjs");
    const env = buildChildEnv(
      process.env,
      { CPB_ROOT: req.cpbRoot, CPB_ACP_TIMEOUT_MS: "90000" },
      { agent: "claude" },
    );

    const acpResult = await new Promise((resolve) => {
      const child = spawn("node", [scriptPath, "--agent", "claude", "--cwd", req.cpbRoot], {
        cwd: req.cpbRoot,
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

    // Parse ACP response
    if (acpResult.error) {
      return { summary: `Analysis failed: ${acpResult.error}`, changes: [], risks: [], recommendation: "Could not complete ACP analysis. Review the session content manually." };
    }

    // Extract JSON from output (agent may wrap in markdown fences)
    let parsed = null;
    const rawOutput = acpResult.output || "";
    const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)```/) || rawOutput.match(/\{[\s\S]*"summary"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } catch { /* fall through */ }
    }

    if (parsed && parsed.summary) {
      return {
        summary: parsed.summary,
        changes: Array.isArray(parsed.changes) ? parsed.changes : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        recommendation: parsed.recommendation || "",
        raw: rawOutput,
      };
    }

    // Fallback: return raw output as summary if JSON parse fails
    return {
      summary: rawOutput.slice(0, 500) || "Analysis produced no output.",
      changes: [],
      risks: [],
      recommendation: "Review the raw analysis output for details.",
      raw: rawOutput,
    };
  });
}

async function cancelRoute(req, reply, notify) {
  const { id } = req.params;
  if (!req.cpbRoot) return reply.code(400).send({ error: "missing project root" });
  const session = await getSession(req.cpbRoot, id);
  if (!session) return reply.code(404).send({ error: "not found" });
  const updated = await updateSession(req.cpbRoot, id, {
    status: "cancelled",
    detail: req.body?.reason || "cancelled",
  }, { skipTransitionCheck: true });
  notify({ type: "review:update", sessionId: id, status: "cancelled", project: session.project, session: updated });
  return { cancelled: true, sessionId: id };
}
