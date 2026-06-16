/**
 * Review Dispatch — session dispatch, analysis, ACP runner, verifier evidence,
 * remediation handler, and repair handler.
 *
 * Merged from:
 *   - review-dispatch.ts          (dispatch, analyze, accept, reject, cancel)
 *   - review-dispatch-runner.ts   (PersistentAcp, prompt builders, runReview)
 *   - verifier-evidence.ts        (evidence collectors)
 *   - remediation-handler.ts      (remediation lifecycle)
 *   - repair-handler.ts           (repair lifecycle)
 */

// ─── review-dispatch.ts ───────────────────────────────────────────
import { spawn } from "node:child_process";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "child_process";
import { runtimeDataPath } from "../runtime.js";
import { enqueue } from "../hub/hub-queue.js";
import { makeJobId } from "../job/job-store.js";
import { getSession, updateSession, parseIssues } from "./review-session.js";
import { buildChildEnv } from "../secret-policy.js";
import { resolveHubRoot, getProject } from "../hub/hub-registry.js";

function gitExec(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

function worktreePathFor(cpbRoot: string, jobId: string): string {
  return runtimeDataPath(cpbRoot, "worktrees", `${jobId}-pipeline`);
}

/**
 * Dispatch a review session to the hub queue.
 * Shared by approve and auto-approve routes.
 */
export async function dispatchSession(cpbRoot: string, sessionId: string, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const storageOptions = { hubRoot: hubRootOverride };
  const session = await getSession(cpbRoot, sessionId, storageOptions);
  if (!session) return { ok: false, error: "session_not_found" };

  const dispatchKey = `review:${session.sessionId}`;
  if (session.status === "dispatched" && session.jobId) {
    return {
      ok: true,
      sessionId: session.sessionId,
      taskId: session.queueEntryId || session.jobId,
      jobId: session.jobId,
      session,
      project: session.project,
    };
  }
  if (session.status !== "user_review" && session.status !== "dispatched") {
    return { ok: false, error: "invalid_state", status: session.status };
  }

  const jobId = makeJobId();
  const wtPath = worktreePathFor(cpbRoot, jobId);
  const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);

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
      queueDedupeKey: dispatchKey,
      jobId,
      workflow: "standard",
      autoFinalize: true,
      requestedAt: new Date().toISOString(),
    },
  });

  try {
    const updated = await updateSession(cpbRoot, session.sessionId, {
      status: "dispatched",
      userVerdict: "approved",
      jobId,
      queueEntryId: entry.id,
      worktreePath: wtPath,
      idempotency: {
        ...session.idempotency,
        dispatchKey,
      },
    }, storageOptions);

    return {
      ok: true,
      sessionId: session.sessionId,
      taskId: entry.id,
      jobId,
      session: updated,
      project: session.project,
    };
  } catch (err) {
    if (err?.message?.includes("already in status: dispatched")) {
      const current = await getSession(cpbRoot, session.sessionId, storageOptions);
      if (current?.status === "dispatched" && current.jobId) {
        return {
          ok: true,
          sessionId: current.sessionId,
          taskId: current.queueEntryId || entry.id,
          jobId: current.jobId,
          session: current,
          project: current.project || session.project,
        };
      }
    }
    throw err;
  }
}

/**
 * Auto-approve path: handles already-dispatched sessions idempotently.
 */
export async function autoApproveSession(cpbRoot: string, sessionId: string, { hubRoot: hubRootOverride }: Record<string, any> = {}) {
  const session = await getSession(cpbRoot, sessionId, { hubRoot: hubRootOverride });
  if (!session) return { ok: false, error: "session_not_found" };

  if (!["dispatched", "user_review"].includes(session.status)) {
    return {
      ok: false,
      error: "invalid_state",
      status: session.status,
      note: "invalid_state_for_auto_approve",
    };
  }

  // If already dispatched with a jobId, just confirm
  if (session.status === "dispatched" && session.jobId) {
    return {
      ok: true,
      dispatched: true,
      sessionId: session.sessionId,
      taskId: session.jobId,
      project: session.project,
      session,
      note: "already_dispatched",
    };
  }

  // Transition from user_review → dispatched, then dispatch
  await updateSession(cpbRoot, session.sessionId, {
    status: "dispatched",
    userVerdict: "approved",
  }, { skipTransitionCheck: true });

  return dispatchSession(cpbRoot, sessionId, { hubRoot: hubRootOverride });
}

/**
 * Cancel a review session.
 */
export async function cancelReviewDispatch(cpbRoot: string, sessionId: string, reason: string, options: Record<string, any> = {}) {
  const session = await getSession(cpbRoot, sessionId, options);
  if (!session) return { ok: false, error: "session_not_found" };

  const updated = await updateSession(cpbRoot, session.sessionId, {
    status: "cancelled",
    detail: reason || "cancelled",
  }, { ...options, skipTransitionCheck: true });

  return { ok: true, sessionId, session: updated, project: session.project };
}

/**
 * Run ACP analysis on a review session.
 */
export async function analyzeSession(cpbRoot: string, sessionId: string, options: Record<string, any> = {}): Promise<Record<string, any>> {
  const session = await getSession(cpbRoot, sessionId, options);
  if (!session) return { ok: false, error: "session_not_found" };

  const sections: string[] = [];
  if (session.intent) sections.push(`## Intent\n${session.intent}`);
  if (session.research?.codex) sections.push(`## Codex Research\n${session.research.codex.slice(0, 3000)}`);
  if (session.research?.claude) sections.push(`## Claude Research\n${session.research.claude.slice(0, 3000)}`);
  if (session.plan) sections.push(`## Implementation Plan\n${session.plan.slice(0, 4000)}`);

  if (session.reviews && session.reviews.length > 0) {
    const latest = session.reviews[session.reviews.length - 1];
    if (latest.codex) sections.push(`## Codex Review (Round ${latest.round})\n${latest.codex.slice(0, 3000)}`);
    if (latest.claude) sections.push(`## Claude Review (Round ${latest.round})\n${latest.claude.slice(0, 3000)}`);
    const issues = [
      ...(latest.codexIssues || []).map((i: Record<string, any>) => `[Codex P${i.severity}] ${i.message || "issue"}`),
      ...(latest.claudeIssues || []).map((i: Record<string, any>) => `[Claude P${i.severity}] ${i.message || "issue"}`),
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

  const scriptPath = path.join(cpbRoot, "server", "services", "acp", "acp-client.js");
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
export async function acceptSession(cpbRoot: string, sessionId: string, options: Record<string, any> = {}) {
  const session = await getSession(cpbRoot, sessionId, options);
  if (!session) return { ok: false, error: "session_not_found" };
  if (session.status !== "user_review" && session.status !== "dispatched") {
    return { ok: false, error: "invalid_state", status: session.status };
  }

  let merged = false;
  let mergeError = null;

  if (session.worktreePath && session.jobId) {
    try {
      const projectJson = path.join(cpbRoot, "wiki", "projects", session.project, "project.json");
      const meta = JSON.parse(await readFile(projectJson, "utf8"));
      const sourcePath = meta.sourcePath;
      if (sourcePath) {
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
      } else {
        mergeError = "sourcePath missing";
        await rm(session.worktreePath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      mergeError = mergeError || (err?.code === "ENOENT" ? "sourcePath missing" : err.message || "sourcePath missing");
      await rm(session.worktreePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  const finalStatus = (!merged && mergeError) ? "merge_failed" : "completed";
  const updated = await updateSession(cpbRoot, session.sessionId, {
    status: finalStatus,
    userVerdict: "accepted",
    merged,
    ...(mergeError && { mergeError }),
  }, options);

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
export async function rejectSession(cpbRoot: string, sessionId: string, options: Record<string, any> = {}) {
  const session = await getSession(cpbRoot, sessionId, options);
  if (!session) return { ok: false, error: "session_not_found" };
  if (session.status !== "user_review") {
    return { ok: false, error: "invalid_state", status: session.status };
  }

  if (session.worktreePath) {
    try {
      const projectJson = path.join(cpbRoot, "wiki", "projects", session.project, "project.json");
      const meta = JSON.parse(await readFile(projectJson, "utf8"));
      if (meta.sourcePath) {
        await gitExec(meta.sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
      }
    } catch {}
    try { await rm(session.worktreePath, { recursive: true, force: true }); } catch {}
  }

  const updated = await updateSession(cpbRoot, session.sessionId, {
    status: "expired",
    userVerdict: "rejected",
  }, options);

  return { ok: true, sessionId, session: updated, project: session.project };
}

// ─── review-dispatch-runner.ts ────────────────────────────────────
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { createSession, startSessionResearch, noteReviewAcpCall, assertReviewBudget } from "./review-session.js";
import { buildChildEnv as buildChildEnvForRunner } from "../../../core/policy/child-env.js";

const CPB_ROOT = path.resolve(".");
const PROTOCOL_VERSION = 1;
const ACP_STUCK_MS = parseInt(process.env.ACP_STUCK_MS || "300000", 10);

// ACP adapter lookup table — mirrors acp-client.js
const ACP_ADAPTERS: Record<string, { command: string; args: string[]; npxPkg: string | null }> = {
  codex:    { command: "codex-acp",         args: [],            npxPkg: "@zed-industries/codex-acp" },
  claude:   { command: "claude-agent-acp",  args: [],            npxPkg: "@agentclientprotocol/claude-agent-acp" },
  reasonix: { command: "reasonix",          args: ["acp"],       npxPkg: null },
};

function commandExists(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd]).status === 0;
}

function resolveAgentCommand(agent: string, env: NodeJS.ProcessEnv = process.env) {
  const upper = agent.toUpperCase();
  const envCmd = env[`CPB_ACP_${upper}_COMMAND`];
  if (envCmd) {
    const raw = env[`CPB_ACP_${upper}_ARGS`];
    let args = [];
    if (raw) {
      try { args = JSON.parse(raw); } catch { args = raw.split(/\s+/).filter(Boolean); }
    }
    return { command: envCmd, args };
  }
  const entry = ACP_ADAPTERS[agent];
  if (!entry) throw new Error(`Unknown agent: '${agent}'. Set CPB_ACP_${upper}_COMMAND.`);
  if (commandExists(entry.command)) return { command: entry.command, args: [...entry.args] };
  if (entry.npxPkg) return { command: "npx", args: ["-y", entry.npxPkg] };
  return { command: entry.command, args: [...entry.args] };
}

class PersistentAcp {
  agent: string;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
  child: Record<string, any> | null;
  initialized: boolean;
  closed: boolean;
  lastActivity: number;
  watchdog: ReturnType<typeof setInterval> | null;
  sessionId: string | null;

  constructor(agent: string) {
    this.agent = agent;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.initialized = false;
    this.closed = false;
    this.lastActivity = Date.now();
    this.watchdog = null;
    this.sessionId = null;
  }

  async start() {
    const env = buildChildEnvForRunner(process.env, {}, { agent: this.agent }) as NodeJS.ProcessEnv;
    const { command, args } = resolveAgentCommand(this.agent, env);
    if (command === "npx" && !env.npm_config_cache) {
      const cache = path.join(tmpdir(), `cpb-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdirAsync(cache, { recursive: true });
      env.npm_config_cache = cache;
    }

    this.child = spawnChild(command, args, {
      cwd: CPB_ROOT,
      env: buildChildEnvForRunner(env, { CPB_ROOT }, { agent: this.agent }),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      this.lastActivity = Date.now();
      this.handleLine(line);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.lastActivity = Date.now();
      process.stderr.write(`[${this.agent}] ${chunk}`);
    });

    this.child.on("exit", () => {
      this.closed = true;
      this.clearWatchdog();
      for (const { reject } of this.pending.values()) {
        reject(new Error(`${this.agent} process exited`));
      }
      this.pending.clear();
    });

    this.child.on("error", (err: Error) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "cpb-review", title: "CodePatchbay Review", version: "0.1.0" },
    });

    if ((init as Record<string, any>).protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol version: ${(init as Record<string, any>).protocolVersion}`);
    }
    this.initialized = true;

    this.startWatchdog();
    return this;
  }

  async sendPrompt(prompt: string): Promise<string> {
    if (this.closed) throw new Error(`${this.agent} connection closed`);
    this.lastActivity = Date.now();

    await this.#ensureSession();

    let response = "";
    const startedAt = Date.now();
    let lastTextAt = Date.now();
    const STUCK_MS = parseInt(process.env.ACP_PROMPT_STUCK_MS || "300000", 10);
    const MAX_MS = parseInt(process.env.ACP_PROMPT_MAX_MS || "600000", 10);

    const collectUpdate = (params: Record<string, any>) => {
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.type === "text") {
        response += update.content.text;
        lastTextAt = Date.now();
      }
    };

    let stuckTimer: ReturnType<typeof setInterval> | null = null;
    const stuckGuard = new Promise((_, reject) => {
      stuckTimer = setInterval(() => {
        const noText = Date.now() - lastTextAt > STUCK_MS;
        const tooLong = Date.now() - startedAt > MAX_MS;
        if (noText || tooLong) {
          clearInterval(stuckTimer);
          const reason = tooLong ? `exceeded max ${MAX_MS}ms` : `no text output for ${STUCK_MS}ms`;
          reject(new Error(`${this.agent} prompt stuck: ${reason}`));
        }
      }, 15000);
    });

    const origHandle = this.handleClientRequest;
    this.handleClientRequest = async (msg: Record<string, any>) => {
      if (msg.method === "session/update") {
        collectUpdate(msg.params);
        if (Object.hasOwn(msg, "id")) this.respond(msg.id, null);
      } else {
        origHandle.call(this, msg);
      }
    };

    try {
      await Promise.race([
        this.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
        stuckGuard,
      ]);
    } catch (err) {
      console.error(`[${this.agent}] sendPrompt error: ${err.message}`);
      await this.#closeSession();
      throw err;
    } finally {
      clearInterval(stuckTimer);
      this.handleClientRequest = origHandle;
    }

    return response.trim();
  }

  async #ensureSession() {
    if (this.sessionId) return;
    const session = await this.request("session/new", { cwd: CPB_ROOT, mcpServers: [] });
    this.sessionId = (session as Record<string, any>).sessionId;
  }

  async #closeSession() {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;
    try {
      this.write({ jsonrpc: "2.0", method: "session/close", params: { sessionId: sid } });
    } catch {}
  }

  async resetSession() {
    await this.#closeSession();
  }

  request(method: string, params: Record<string, any>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.agent} connection closed`));
    const id = this.nextId++;
    this.lastActivity = Date.now();
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  write(msg: Record<string, any>): void {
    if (this.child?.stdin.destroyed) throw new Error("stdin closed");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  handleLine(line: string): void {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (Object.hasOwn(msg, "id") && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `ACP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method) this.handleClientRequest(msg);
  }

  handleClientRequest(msg: Record<string, any>): void {
    if (Object.hasOwn(msg, "id")) this.respond(msg.id, null);
  }

  startWatchdog() {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > ACP_STUCK_MS) {
        this.close();
        for (const { reject } of this.pending.values()) {
          reject(new Error(`${this.agent} heartbeat timeout: no activity for ${ACP_STUCK_MS}ms`));
        }
        this.pending.clear();
      }
    }, 10000);
  }

  clearWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  async restart() {
    this.close();
    this.closed = false;
    this.pending.clear();
    this.nextId = 1;
    this.sessionId = null;
    return this.start();
  }

  close() {
    this.clearWatchdog();
    if (this.sessionId) {
      try { this.#closeSession(); } catch {}
    }
    if (this.child && !this.closed) {
      try {
        this.child.stdin.end();
        setTimeout(() => {
          try { process.kill(-this.child.pid, "SIGTERM"); } catch { this.child?.kill("SIGTERM"); }
        }, 500).unref();
      } catch {}
    }
    this.closed = true;
  }
}

// --- Prompt builders ---

function researchPrompt(intent: string, project: string): string {
  return `You are CodePatchbay Research Agent. Analyze this task intent for project "${project}":

**Task**: ${intent}

Provide:
1. Feasibility assessment (technical complexity, estimated effort)
2. Key risks and dependencies
3. Suggested approach (high-level)
4. Questions or ambiguities that need clarification

Be concise and structured.`;
}

function planPrompt(intent: string, codexResearch: string, claudeResearch: string): string {
  return `You are CodePatchbay Planner. Based on the research below, create an implementation plan.

**Task**: ${intent}

**Codex Research**:
${codexResearch || "N/A"}

**Claude Research**:
${claudeResearch || "N/A"}

Create a structured plan with:
1. Clear phases with deliverables
2. File-by-file changes
3. Risk mitigation strategies
4. Acceptance criteria

Output the plan as markdown.`;
}

function reviewPrompt(plan: string, reviewer: string): string {
  return `You are CodePatchbay ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer.
Review this plan critically. For each issue found, use severity tags [P0] [P1] [P2] [P3]:

- [P0] Critical: Will cause system failure or data loss
- [P1] High: Major functional defect or security vulnerability
- [P2] Medium: Performance issue, poor design, or missing edge case
- [P3] Low: Style, naming, or minor improvement

If the plan has no P2+ issues, respond with: "REVIEW: PASS"

**Plan to review**:
${plan}`;
}

function followUpReviewPrompt(reviewer: string, previousIssues: Record<string, any>[], revisedPlan: string): string {
  const issueSummary = previousIssues
    .filter((i: Record<string, any>) => i.severity >= 2)
    .map((i: Record<string, any>) => `[P${i.severity}] ${i.description}`)
    .join("\n") || "None";

  return `You are CodePatchbay ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer (follow-up).
This is a revised plan addressing previous review issues.

**Previous issues**:
${issueSummary}

**Revised plan**:
${revisedPlan}

Review ONLY whether the previous issues were adequately addressed. For new issues use [P0]-[P3] tags. If all previous P2+ issues are resolved and no new P2+ issues exist, respond with: "REVIEW: PASS"`;
}

function revisePrompt(plan: string, codexIssues: Record<string, any>[], claudeIssues: Record<string, any>[]): string {
  const allIssues = [...codexIssues, ...claudeIssues]
    .filter((i: Record<string, any>) => i.severity >= 2)
    .map((i: Record<string, any>) => `[P${i.severity}] ${i.description}`)
    .join("\n");

  return `You are CodePatchbay Plan Reviser. Revise this plan to address the issues below.

**Issues found by reviewers**:
${allIssues}

**Original plan**:
${plan}

Provide the revised plan as markdown, addressing each issue.`;
}

// --- Main review cpb ---

const MAX_RETRIES = parseInt(process.env.ACP_MAX_RETRIES || "2", 10);
const MAX_REVIEW_ROUNDS = parseInt(process.env.CPB_REVIEW_MAX_ROUNDS || "5", 10);

async function sendWithRetry(acp: PersistentAcp, prompt: string, agent: string, retries: number = MAX_RETRIES): Promise<string> {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await acp.sendPrompt(prompt);
    } catch (err) {
      console.error(`[review] ${agent} attempt ${attempt}/${retries + 1} failed: ${err.message}`);
      if (attempt <= retries) {
        console.log(`[review] restarting ${agent} ACP connection`);
        await acp.restart();
      } else {
        throw err;
      }
    }
  }
}

export async function runReview(cpbRoot: string, sessionId: string): Promise<void> {
  const session = await getSession(cpbRoot, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  let codex, claude;

  try {
    [codex, claude] = await Promise.all([
      new PersistentAcp("codex").start(),
      new PersistentAcp("claude").start(),
    ]);

    // Phase 1: Research. HTTP routes may already have moved the session into
    // researching to enforce idempotency before spawning this runner.
    const initialSession = await getSession(cpbRoot, sessionId);
    if (initialSession?.status === "idle") {
      await startSessionResearch(cpbRoot, sessionId, `dispatch-${sessionId}`);
    }
    console.log(`[review] ${sessionId} phase 1: researching`);

    let currentBudget = await getSession(cpbRoot, sessionId);
    assertReviewBudget(currentBudget);

    const codexResearchPrompt = researchPrompt(session.intent, session.project);
    const claudeResearchPrompt = researchPrompt(session.intent, session.project);
    const [codexRes, claudeRes] = await Promise.allSettled([
      sendWithRetry(codex, codexResearchPrompt, "codex"),
      sendWithRetry(claude, claudeResearchPrompt, "claude"),
    ]);
    await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: codexResearchPrompt.length });
    await noteReviewAcpCall(cpbRoot, sessionId, { agent: "claude", promptBytes: claudeResearchPrompt.length });

    const codexResearch = codexRes.status === "fulfilled" ? codexRes.value : "";
    const claudeResearch = claudeRes.status === "fulfilled" ? claudeRes.value : "";
    if (!codexResearch && !claudeResearch) throw new Error("both research agents failed");
    await updateSession(cpbRoot, sessionId, {
      research: { codex: codexResearch, claude: claudeResearch },
    });

    // Phase 2: Plan
    await updateSession(cpbRoot, sessionId, { status: "planning" });
    console.log(`[review] ${sessionId} phase 2: planning`);
    currentBudget = await getSession(cpbRoot, sessionId);
    assertReviewBudget(currentBudget);
    const planPromptText = planPrompt(session.intent, codexResearch, claudeResearch);
    const plan = await sendWithRetry(codex, planPromptText, "codex");
    await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: planPromptText.length });
    await updateSession(cpbRoot, sessionId, { plan });

    // Phase 3: Review Loop
    let currentPlan = plan;
    let prevCodexIssues: Record<string, unknown>[] = [];
    let prevClaudeIssues: Record<string, unknown>[] = [];
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      await updateSession(cpbRoot, sessionId, { status: "reviewing", round });
      console.log(`[review] ${sessionId} round ${round}: reviewing`);

      // Budget check before review round
      currentBudget = await getSession(cpbRoot, sessionId);
      try {
        assertReviewBudget(currentBudget);
      } catch (budgetErr) {
        await updateSession(cpbRoot, sessionId, { status: "expired", detail: budgetErr.message });
        console.log(`[review] ${sessionId} expired: ${budgetErr.message}`);
        return;
      }

      // Reset sessions between rounds for independent reviews
      await codex.resetSession().catch((): null => null);
      await claude.resetSession().catch((): null => null);

      const codexPrompt = round === 1
        ? reviewPrompt(currentPlan, "codex")
        : followUpReviewPrompt("codex", prevCodexIssues, currentPlan);
      const claudePrompt = round === 1
        ? reviewPrompt(currentPlan, "claude")
        : followUpReviewPrompt("claude", prevClaudeIssues, currentPlan);

      const results = await Promise.allSettled([
        sendWithRetry(codex, codexPrompt, "codex"),
        sendWithRetry(claude, claudePrompt, "claude"),
      ]);
      await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: codexPrompt.length });
      await noteReviewAcpCall(cpbRoot, sessionId, { agent: "claude", promptBytes: claudePrompt.length });

      const codexReview = results[0].status === "fulfilled" ? results[0].value : "";
      const claudeReview = results[1].status === "fulfilled" ? results[1].value : "";
      if (results[0].status === "rejected") console.error(`[review] codex review failed: ${results[0].reason?.message}`);
      if (results[1].status === "rejected") console.error(`[review] claude review failed: ${results[1].reason?.message}`);
      if (!codexReview && !claudeReview) throw new Error("both reviewers failed");

      const codexIssues = parseIssues(codexReview);
      const claudeIssues = parseIssues(claudeReview);
      prevCodexIssues = codexIssues;
      prevClaudeIssues = claudeIssues;

      const reviews = (await getSession(cpbRoot, sessionId)).reviews;
      await updateSession(cpbRoot, sessionId, {
        reviews: [...reviews, { round, codex: codexReview, claude: claudeReview, codexIssues, claudeIssues }],
      });

      const hasP2 = [...codexIssues, ...claudeIssues].some((i) => i.severity >= 2);
      console.log(`[review] ${sessionId} round ${round}: codex=${codexIssues.length} claude=${claudeIssues.length} hasP2=${hasP2}`);
      if (!hasP2) {
        await updateSession(cpbRoot, sessionId, { status: "user_review" });
        console.log(`[review] ${sessionId} passed at round ${round}`);
        return;
      }

      if (round < MAX_REVIEW_ROUNDS) {
        await updateSession(cpbRoot, sessionId, { status: "revising" });
        console.log(`[review] ${sessionId} revising for round ${round + 1}`);

        // Budget check before revise
        currentBudget = await getSession(cpbRoot, sessionId);
        try {
          assertReviewBudget(currentBudget);
        } catch (budgetErr) {
          await updateSession(cpbRoot, sessionId, { status: "expired", detail: budgetErr.message });
          console.log(`[review] ${sessionId} expired: ${budgetErr.message}`);
          return;
        }

        const revisePromptText = revisePrompt(currentPlan, codexIssues, claudeIssues);
        const revised = await sendWithRetry(codex, revisePromptText, "codex");
        await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: revisePromptText.length });
        currentPlan = revised;
        await updateSession(cpbRoot, sessionId, { plan: revised });
      }
    }

    await updateSession(cpbRoot, sessionId, { status: "expired" });
    console.log(`[review] ${sessionId} expired after ${MAX_REVIEW_ROUNDS} rounds`);
  } catch (err) {
    console.error(`[review] ${sessionId} error: ${err.message}`);
    try { await updateSession(cpbRoot, sessionId, { status: "expired" }); } catch {}
  } finally {
    codex?.close();
    claude?.close();
  }
}

// ─── verifier-evidence.ts ─────────────────────────────────────────
import { stat } from "node:fs/promises";
import { execFile as execFileVerifier } from "node:child_process";
import { promisify as promisifyVerifier } from "node:util";
import { readEvents } from "../event/event-store.js";
import { reconstructJobState, contextPath, decisionsPath, outputsDir } from "../phase-locator.js";
import { CPB_RUNTIME_ENV, RUNTIME_BASICS } from "../secret-policy.js";

const execFileVerifierAsync = promisifyVerifier(execFileVerifier);

function buildVerifierCommandEnv(parentEnv: NodeJS.ProcessEnv = process.env) {
  const allowed = new Set([...RUNTIME_BASICS, ...CPB_RUNTIME_ENV]);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (allowed.has(key)) env[key] = value;
  }
  return env;
}

export async function collectCurrentDiff(sourcePath: string, { maxLines = 200 }: Record<string, any> = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const { stdout } = await execFileVerifierAsync("git", ["diff", "--stat", "HEAD"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      maxBuffer: 1024 * 1024,
    });
    return { available: true, diff: stdout.slice(0, maxLines * 200) };
  } catch {
    return { available: false, reason: "git diff failed or not a git repo" };
  }
}

export async function collectUncommittedDiff(sourcePath: string, { maxLines = 200 }: Record<string, any> = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const { stdout } = await execFileVerifierAsync("git", ["diff"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      maxBuffer: 1024 * 1024,
    });
    const truncated = stdout.split("\n").slice(0, maxLines).join("\n");
    return { available: true, diff: truncated };
  } catch {
    return { available: false, reason: "git diff failed" };
  }
}

export async function collectTestResults(sourcePath: string, { timeout = 30_000 }: Record<string, any> = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const pkgPath = path.join(sourcePath, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const testScript = pkg.scripts?.test;
    if (!testScript) return { available: false, reason: "no test script" };

    const { stdout, stderr } = await execFileVerifierAsync("npm", ["test"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { available: true, stdout: stdout.slice(-5000), stderr: stderr.slice(-5000) };
  } catch (err) {
    const stdout = err.stdout?.slice(-5000) || "";
    const stderr = err.stderr?.slice(-5000) || "";
    return { available: true, exitCode: err.code || 1, stdout, stderr };
  }
}

export async function collectEventLog(cpbRoot: string, project: string, jobId: string, { maxEvents = 50, dataRoot = null }: Record<string, any> = {}) {
  try {
    const events = await readEvents(cpbRoot, project, jobId, dataRoot
      ? { dataRoot, includeLegacyFallback: false }
      : {});
    if (events.length === 0) {
      return { available: false, reason: "event log is empty or missing" };
    }
    const recent = events.slice(-maxEvents);
    return { available: true, eventCount: events.length, events: recent };
  } catch {
    return { available: false, reason: "event log not found" };
  }
}

export async function collectProjectContext(cpbRoot: string, project: string, options: Record<string, any> = {}) {
  const ctx = await readFile(contextPath(cpbRoot, project, options), "utf8").catch((): null => null);
  const decisions = await readFile(decisionsPath(cpbRoot, project, options), "utf8").catch((): null => null);

  return {
    available: Boolean(ctx || decisions),
    context: ctx,
    decisions,
  };
}

export async function collectDeliverable(cpbRoot: string, project: string, deliverableId: string, options: Record<string, any> = {}) {
  if (!deliverableId) return { available: false, reason: "no deliverable ID" };

  const file = path.join(outputsDir(cpbRoot, project, options), `deliverable-${deliverableId}.md`);
  try {
    const content = await readFile(file, "utf8");
    return { available: true, content, path: file };
  } catch {
    return { available: false, reason: `deliverable file not found: ${file}` };
  }
}

export async function collectVerifierEvidence(cpbRoot: string, project: string, jobId: string, { sourcePath, deliverableId, dataRoot: explicitDataRoot = null }: Record<string, any> = {}) {
  const jobState = await reconstructJobState(cpbRoot, project, jobId);

  const evidence: Record<string, any> = {
    jobState,
    deliverable: null,
    diff: null,
    uncommittedDiff: null,
    eventLog: null,
    projectContext: null,
    testResults: null,
    diagnostics: [] as Record<string, unknown>[],
  };

  const dataRoot = explicitDataRoot || jobState?.stateRoot || null;
  const runtimeOptions = dataRoot ? { dataRoot } : {};
  const resolvedSourcePath = sourcePath || jobState?.sourcePath || jobState?.worktree || null;

  const [deliverable, diff, uncommittedDiff, eventLog, projectContext, testResults] = await Promise.all([
    collectDeliverable(cpbRoot, project, deliverableId, runtimeOptions).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectCurrentDiff(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectUncommittedDiff(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectEventLog(cpbRoot, project, jobId, runtimeOptions).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectProjectContext(cpbRoot, project, runtimeOptions).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectTestResults(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
  ]);

  evidence.deliverable = deliverable;
  evidence.diff = diff;
  evidence.uncommittedDiff = uncommittedDiff;
  evidence.eventLog = eventLog;
  evidence.projectContext = projectContext;
  evidence.testResults = testResults;

  if (!deliverable.available) {
    evidence.diagnostics.push({
      level: "info",
      message: `deliverable not available: ${deliverable.reason}`,
    });
  }
  if (!diff.available) {
    evidence.diagnostics.push({
      level: "info",
      message: `diff not available: ${diff.reason}`,
    });
  }
  if (!eventLog.available) {
    evidence.diagnostics.push({
      level: "warning",
      message: `event log not available: ${eventLog.reason}`,
    });
  }

  return evidence;
}

// ─── remediation-handler.ts ───────────────────────────────────────
import { mkdir as mkdirRem, rmdir as rmdirRem, readFile as readFileRem } from "node:fs/promises";
import { appendEvent as appendEventRem, checkpointJob as checkpointJobRem, readEvents as readEventsRem, materializeJob as materializeJobRem } from "../event/event-store.js";
import { readJobsIndex, updateJobsIndexEntry as updateJobsIndexEntryRem } from "../job/job-store.js";
import { resolveHubRoot as resolveHubRootRem } from "../hub/hub-registry.js";
import { enqueue as enqueueRem, listQueue } from "../hub/hub-queue.js";
import { allocateArtifactId } from "../artifact-locator.js";
import { runtimeDataRoot, resolveProjectDataRoot } from "../runtime.js";

function remediationDataRoot(cpbRoot: string, options: Record<string, any> = {}): string {
  return options.dataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
}

async function resolveRemediationDataRoot(cpbRoot: string, project: string, { hubRoot, dataRoot, lockDir }: Record<string, any> = {}): Promise<string> {
  if (dataRoot) return dataRoot;
  if (lockDir) {
    const marker = `${path.sep}remediation-locks${path.sep}`;
    const markerIndex = lockDir.indexOf(marker);
    if (markerIndex > 0) return lockDir.slice(0, markerIndex);
  }
  return resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
}

function validateIdRem(name: string, value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRemediationLock(cpbRoot: string, project: string, jobId: string, options: Record<string, any> = {}): Promise<string> {
  const lockDir = path.join(remediationDataRoot(cpbRoot, options), "remediation-locks", project, `${jobId}.lock`);
  await mkdirRem(path.dirname(lockDir), { recursive: true });
  try {
    await mkdirRem(lockDir);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Remediation already running for ${project}/${jobId}`);
    }
    throw err;
  }
  return lockDir;
}

async function releaseRemediationLock(lockDir: string): Promise<void> {
  try {
    await rmdirRem(lockDir);
  } catch {}
}

async function recordRemediationEvent(cpbRoot: string, project: string, jobId: string, event: Record<string, any>, options: Record<string, any> = {}): Promise<void> {
  await appendEventRem(cpbRoot, project, jobId, event, options);
  await checkpointJobRem(cpbRoot, project, jobId, options).catch(() => {});
  const state = materializeJobRem(await readEventsRem(cpbRoot, project, jobId, options));
  await updateJobsIndexEntryRem(cpbRoot, project, jobId, state, options).catch(() => {});
}

export async function runRemediation(cpbRoot: string, { project, jobId, executorRoot = null, hubRoot, dataRoot: explicitDataRoot }: Record<string, any>) {
  validateIdRem("project", project);
  validateIdRem("jobId", jobId);

  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: explicitDataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
  const wikiDir = path.join(dataRoot, "wiki");
  const outputsDir = path.join(wikiDir, "outputs");
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  const lockDir = await acquireRemediationLock(cpbRoot, project, jobId, eventOpts);

  try {
    let events;
    try {
      events = await readEventsRem(cpbRoot, project, jobId, eventOpts);
    } catch {
      events = [];
    }
    if (events.length === 0) {
      throw new Error(`event file not found or empty for job ${jobId}`);
    }
    const job = materializeJobRem(events);

    const remediationId = await allocateArtifactId(outputsDir, "remediation");
    const remediationFile = path.join(outputsDir, `remediation-${remediationId}.md`);
    const remediationArtifact = `remediation-${remediationId}`;

    let sourcePath = "";
    try {
      const metaFile = path.join(wikiDir, "project.json");
      const meta = JSON.parse(await readFileRem(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
    } catch {}

    return { remediationId, remediationFile, remediationArtifact, workflow: job?.workflow || "", sourcePath, dataRoot, lockDir };
  } catch (err) {
    await releaseRemediationLock(lockDir);
    throw err;
  }
}

export async function completeRemediation(cpbRoot: string, { project, jobId, remediationId, remediationFile, remediationArtifact, status, error, executorRoot, hubRoot, dataRoot: explicitDataRoot, lockDir }: Record<string, any>) {
  const dataRoot = await resolveRemediationDataRoot(cpbRoot, project, { hubRoot, dataRoot: explicitDataRoot, lockDir });
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  try {
    if (status === "failed") {
      await recordRemediationEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: error || "unknown error",
        ts: new Date().toISOString(),
      }, eventOpts);
      return;
    }

    let remediationContent;
    try {
      remediationContent = await readFileRem(remediationFile, "utf8");
    } catch {
      await recordRemediationEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: "remediation report not created",
        ts: new Date().toISOString(),
      }, eventOpts);
      throw new Error("remediation report not created");
    }

    const remediationStatus = parseRemediationStatus(remediationContent);
    if (!remediationStatus) {
      await recordRemediationEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: `invalid remediation status: ${remediationStatus === null ? "missing" : remediationStatus}`,
        ts: new Date().toISOString(),
      }, eventOpts);
      throw new Error("invalid remediation status");
    }

    await recordRemediationEvent(cpbRoot, project, jobId, {
      type: "external_remediation_completed",
      jobId,
      project,
      artifact: remediationArtifact,
      file: remediationFile,
      remediationStatus,
      ts: new Date().toISOString(),
    }, eventOpts);

    if (remediationStatus === "FIXED") {
      await markJobSuperseded(cpbRoot, project, jobId, eventOpts);
      await createRemediationLineageTask(cpbRoot, { project, jobId, remediationArtifact, remediationStatus, executorRoot, dataRoot });
    }

    return remediationStatus;
  } finally {
    if (lockDir) await releaseRemediationLock(lockDir);
  }
}

function parseRemediationStatus(content: string): string | null {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REMEDIATION:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function markJobSuperseded(cpbRoot: string, project: string, jobId: string, options: Record<string, any> = {}): Promise<void> {
  await recordRemediationEvent(cpbRoot, project, jobId, {
    type: "job_superseded",
    jobId,
    project,
    reason: "external_remediation_fixed",
    ts: new Date().toISOString(),
  }, options);
  const state = materializeJobRem(await readEventsRem(cpbRoot, project, jobId, options));
  if (state) {
    state.status = "superseded";
    await updateJobsIndexEntryRem(cpbRoot, project, jobId, state, options).catch(() => {});
  }
}

async function createRemediationLineageTask(cpbRoot: string, { project, jobId, remediationArtifact, remediationStatus, executorRoot, dataRoot }: Record<string, any>): Promise<void> {
  const eventOpts = dataRoot ? { dataRoot, includeLegacyFallback: false } : {};
  const job = materializeJobRem(await readEventsRem(cpbRoot, project, jobId, eventOpts));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  // Skip if a completed job already exists for the same task
  try {
    const index = await readJobsIndex(cpbRoot, eventOpts);
    const jobs = index?.jobs || {};
    const alreadyCompleted = Object.values(jobs).some(
      (j) => {
        const candidate = j as Record<string, any>;
        return candidate && candidate.task === job.task && candidate.status === "completed" && candidate.project === project;
      },
    );
    if (alreadyCompleted) {
      console.log(`Skip lineage task: task already completed — ${job.task.slice(0, 60)}`);
      return;
    }
  } catch {}

  const hubRoot = resolveHubRootRem(cpbRoot);
  const entries = await listQueue(hubRoot, { projectId: project });
  const origin =
    entries.find((entry) => entry.metadata?.jobId === jobId) ||
    entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
    entries.find((entry) => entry.description === job.task) ||
    null;

  let sourcePath = origin?.sourcePath || "";
  if (!sourcePath) {
    try {
      const metaFile = path.join(cpbRoot, "wiki", "projects", project, "project.json");
      const meta = JSON.parse(await readFileRem(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
    } catch {}
  }

  const entry = await enqueueRem(hubRoot, {
    projectId: project,
    sourcePath,
    sessionId: origin?.sessionId || null,
    workerId: origin?.workerId || null,
    cwd: origin?.cwd || sourcePath,
    executionBoundary: origin?.executionBoundary || "worktree",
    type: origin?.type || "pipeline",
    priority: origin?.priority || "P2",
    description: job.task,
    metadata: {
      ...(origin?.metadata || {}),
      originJobId: jobId,
      originQueueEntryId: origin?.id || null,
      remediationArtifact,
      remediationStatus,
      lineageReason: "external_remediation_fixed_cpb_self_bug",
      sourceContext: {
        ...(origin?.metadata?.sourceContext || job.sourceContext || {}),
        remediation: {
          previousJobId: jobId,
          previousQueueEntryId: origin?.id || null,
          remediationArtifact,
          remediationStatus,
          lineageReason: "external_remediation_fixed_cpb_self_bug",
          failureReason: job.blockedReason || null,
          failurePhase: job.failurePhase || null,
          failureCode: job.failureCode || null,
          artifacts: job.artifacts || {},
        },
        retry: {
          failureKind: job.failureCode || "external_remediation",
          failureReason: job.blockedReason || "external remediation requested",
          previousJobId: jobId,
          previousPhase: job.failurePhase || null,
          previousOutput: "",
        },
      },
    },
  });

  console.log(`New task: ${entry.id}`);
}

// ─── repair-handler.ts ────────────────────────────────────────────
import { mkdir as mkdirRepair, rmdir as rmdirRepair, readFile as readFileRepair } from "node:fs/promises";
import { appendEvent as appendEventRepair, checkpointJob as checkpointJobRepair, readEvents as readEventsRepair, materializeJob as materializeJobRepair } from "../event/event-store.js";
import { updateJobsIndexEntry as updateJobsIndexEntryRepair } from "../job/job-store.js";
import { resolveHubRoot as resolveHubRootRepair } from "../hub/hub-registry.js";
import { enqueue as enqueueRepair, listQueue as listQueueRepair } from "../hub/hub-queue.js";
import { allocateArtifactId as allocateArtifactIdRepair } from "../artifact-locator.js";

function validateIdRepair(name: string, value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRepairLock(cpbRoot: string, project: string, jobId: string, options: Record<string, any> = {}): Promise<string> {
  const root = options.dataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
  const lockDir = path.join(root, "repair-locks", project, `${jobId}.lock`);
  await mkdirRepair(path.dirname(lockDir), { recursive: true });
  try {
    await mkdirRepair(lockDir);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Repair already running for ${project}/${jobId}`);
    }
    throw err;
  }
  return lockDir;
}

async function resolveRepairDataRoot(cpbRoot: string, project: string, { hubRoot, dataRoot, lockDir }: Record<string, any> = {}): Promise<string> {
  if (dataRoot) return dataRoot;
  if (lockDir) {
    const marker = `${path.sep}repair-locks${path.sep}`;
    const markerIndex = lockDir.indexOf(marker);
    if (markerIndex > 0) return lockDir.slice(0, markerIndex);
  }
  return resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
}

async function releaseRepairLock(lockDir: string): Promise<void> {
  try {
    await rmdirRepair(lockDir);
  } catch {}
}

async function recordRepairEvent(cpbRoot: string, project: string, jobId: string, event: Record<string, any>, options: Record<string, any> = {}): Promise<void> {
  await appendEventRepair(cpbRoot, project, jobId, event, options);
  await checkpointJobRepair(cpbRoot, project, jobId, options).catch(() => {});
  const state = materializeJobRepair(await readEventsRepair(cpbRoot, project, jobId, options));
  await updateJobsIndexEntryRepair(cpbRoot, project, jobId, state, options).catch(() => {});
}

export async function runRepair(cpbRoot: string, { project, jobId, executorRoot, hubRoot, dataRoot: explicitDataRoot }: Record<string, any>) {
  validateIdRepair("project", project);
  validateIdRepair("jobId", jobId);

  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: explicitDataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
  const outputsDir = path.join(dataRoot, "wiki", "outputs");
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  const lockDir = await acquireRepairLock(cpbRoot, project, jobId, eventOpts);

  try {
    const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    let events;
    try {
      events = await readEventsRepair(cpbRoot, project, jobId, eventOpts);
    } catch {
      events = [];
    }
    if (events.length === 0) {
      throw new Error(`event file not found or empty: ${eventFile}`);
    }

    const repairId = await allocateArtifactIdRepair(outputsDir, "repair");
    const repairFile = path.join(outputsDir, `repair-${repairId}.md`);
    const repairArtifact = `repair-${repairId}`;

    return { repairId, repairFile, repairArtifact, dataRoot, lockDir };
  } catch (err) {
    await releaseRepairLock(lockDir);
    throw err;
  }
}

export async function completeRepair(cpbRoot: string, { project, jobId, repairId, repairFile, repairArtifact, status, error, executorRoot, hubRoot, dataRoot: explicitDataRoot, lockDir }: Record<string, any>) {
  const dataRoot = await resolveRepairDataRoot(cpbRoot, project, { hubRoot, dataRoot: explicitDataRoot, lockDir });
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  if (status === "failed") {
    await recordRepairEvent(cpbRoot, project, jobId, {
      type: "external_repair_failed",
      jobId,
      project,
      artifact: repairArtifact,
      file: repairFile,
      error: error || "unknown error",
      ts: new Date().toISOString(),
    }, eventOpts);
    if (lockDir) await releaseRepairLock(lockDir);
    return;
  }

  let repairContent;
  try {
    repairContent = await readFileRepair(repairFile, "utf8");
  } catch {
    await recordRepairEvent(cpbRoot, project, jobId, {
      type: "external_repair_failed",
      jobId,
      project,
      artifact: repairArtifact,
      file: repairFile,
      error: "repair report not created",
      ts: new Date().toISOString(),
    }, eventOpts);
    if (lockDir) await releaseRepairLock(lockDir);
    throw new Error("repair report not created");
  }

  const repairStatus = parseRepairStatus(repairContent);
  if (!repairStatus) {
    await recordRepairEvent(cpbRoot, project, jobId, {
      type: "external_repair_failed",
      jobId,
      project,
      artifact: repairArtifact,
      file: repairFile,
      error: `invalid repair status: ${repairStatus === null ? "missing" : repairStatus}`,
      ts: new Date().toISOString(),
    }, eventOpts);
    if (lockDir) await releaseRepairLock(lockDir);
    throw new Error("invalid repair status");
  }

  await recordRepairEvent(cpbRoot, project, jobId, {
    type: "external_repair_completed",
    jobId,
    project,
    artifact: repairArtifact,
    file: repairFile,
    repairStatus,
    ts: new Date().toISOString(),
  }, eventOpts);

  if (repairStatus === "FIXED") {
    await createRepairLineageTask(cpbRoot, { project, jobId, repairArtifact, repairStatus, executorRoot, dataRoot });
  }

  if (lockDir) await releaseRepairLock(lockDir);
  return repairStatus;
}

function parseRepairStatus(content: string): string | null {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REPAIR:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function createRepairLineageTask(cpbRoot: string, { project, jobId, repairArtifact, repairStatus, executorRoot, dataRoot }: Record<string, any>): Promise<void> {
  const eventOpts = dataRoot ? { dataRoot, includeLegacyFallback: false } : {};
  const job = materializeJobRepair(await readEventsRepair(cpbRoot, project, jobId, eventOpts));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  const hubRoot = resolveHubRootRepair(cpbRoot);
  const entries = await listQueueRepair(hubRoot, { projectId: project });
  const origin =
    entries.find((entry) => entry.metadata?.jobId === jobId) ||
    entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
    entries.find((entry) => entry.description === job.task) ||
    null;

  let sourcePath = origin?.sourcePath || "";
  if (!sourcePath) {
    try {
      const metaFile = path.join(cpbRoot, "wiki", "projects", project, "project.json");
      const meta = JSON.parse(await readFileRepair(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
    } catch {}
  }

  const jobRecord = job as Record<string, any>;
  const entry = await enqueueRepair(hubRoot, {
    projectId: project,
    sourcePath,
    sessionId: origin?.sessionId || null,
    workerId: origin?.workerId || null,
    cwd: origin?.cwd || sourcePath,
    executionBoundary: origin?.executionBoundary || "worktree",
    type: origin?.type || "pipeline",
    priority: origin?.priority || "P2",
    description: job.task,
    metadata: {
      ...(origin?.metadata || {}),
      originJobId: jobId,
      originQueueEntryId: origin?.id || null,
      repairArtifact,
      repairStatus,
      lineageReason: "external_repair_fixed_cpb_self_bug",
      sourceContext: {
        ...(origin?.metadata?.sourceContext || job.sourceContext || {}),
        repair: {
          previousJobId: jobId,
          previousQueueEntryId: origin?.id || null,
          repairArtifact,
          repairStatus,
          lineageReason: "external_repair_fixed_cpb_self_bug",
          failureReason: job.blockedReason || null,
          failurePhase: job.failurePhase || null,
          failureCode: job.failureCode || null,
          artifacts: job.artifacts || {},
        },
        retry: {
          failureKind: job.failureCode || "external_repair",
          failureReason: job.blockedReason || "external repair requested",
          previousJobId: jobId,
          previousPhase: job.failurePhase || null,
          previousOutput: "",
          artifacts: job.artifacts || {},
        },
        previousFailure: {
          kind: job.failureCode || "external_repair",
          reason: job.blockedReason || "external repair requested",
          jobId,
          phase: job.failurePhase || null,
          artifacts: job.artifacts || {},
          verdict: jobRecord.verdict || null,
          adversarialVerdict: jobRecord.adversarialVerdict || null,
        },
      },
    },
  });

  console.log(`New task: ${entry.id}`);
}
