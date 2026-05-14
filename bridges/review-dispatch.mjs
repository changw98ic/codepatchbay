#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { createSession, getSession, updateSession, parseIssues } from "../server/services/review-session.js";

const FLOW_ROOT = path.resolve(".");
const PROTOCOL_VERSION = 1;
const ACP_STUCK_MS = parseInt(process.env.ACP_STUCK_MS || "300000", 10);

// --- Persistent ACP connection ---

function commandExists(cmd) {
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd]).status === 0;
}

function resolveAgentCommand(agent) {
  const upper = agent.toUpperCase();
  const envCmd = process.env[`FLOW_ACP_${upper}_COMMAND`];
  if (envCmd) {
    const envArgs = process.env[`FLOW_ACP_${upper}_ARGS`];
    return { command: envCmd, args: envArgs ? JSON.parse(envArgs) : [] };
  }
  if (agent === "codex") {
    return commandExists("codex-acp")
      ? { command: "codex-acp", args: [] }
      : { command: "npx", args: ["-y", "@zed-industries/codex-acp"] };
  }
  return commandExists("claude-agent-acp")
    ? { command: "claude-agent-acp", args: [] }
    : { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] };
}

class PersistentAcp {
  constructor(agent) {
    this.agent = agent;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.initialized = false;
    this.closed = false;
    this.lastActivity = Date.now();
    this.watchdog = null;
  }

  async start() {
    const { command, args } = resolveAgentCommand(this.agent);
    const env = { ...process.env };
    if (command === "npx" && !env.npm_config_cache) {
      const cache = path.join(tmpdir(), `flow-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdir(cache, { recursive: true });
      env.npm_config_cache = cache;
    }

    this.child = spawn(command, args, {
      cwd: FLOW_ROOT,
      env: { ...env, FLOW_ROOT },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      this.lastActivity = Date.now();
      this.handleLine(line);
    });

    this.child.stderr.on("data", (chunk) => {
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

    this.child.on("error", (err) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "flow-review", title: "Flow Review", version: "0.1.0" },
    });

    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol version: ${init.protocolVersion}`);
    }
    this.initialized = true;

    this.startWatchdog();
    return this;
  }

  async sendPrompt(prompt) {
    if (this.closed) throw new Error(`${this.agent} connection closed`);
    this.lastActivity = Date.now();

    const session = await this.request("session/new", { cwd: FLOW_ROOT, mcpServers: [] });

    let response = "";
    const originalHandler = this.handleClientRequest.bind(this);

    // Collect agent messages into response
    const collectUpdate = (params) => {
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.type === "text") {
        response += update.content.text;
      }
    };

    // Temporarily intercept session/update to collect response
    const origHandle = this.handleClientRequest;
    this.handleClientRequest = async (msg) => {
      if (msg.method === "session/update") {
        collectUpdate(msg.params);
        if (Object.hasOwn(msg, "id")) this.respond(msg.id, null);
      } else {
        origHandle.call(this, msg);
      }
    };

    try {
      await this.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });

      // Close session if supported
      await this.request("session/close", { sessionId: session.sessionId }).catch(() => null);
    } finally {
      this.handleClientRequest = origHandle;
    }

    return response.trim();
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error(`${this.agent} connection closed`));
    const id = this.nextId++;
    this.lastActivity = Date.now();
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  write(msg) {
    if (this.child?.stdin.destroyed) throw new Error("stdin closed");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  handleLine(line) {
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

  handleClientRequest(msg) {
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

  close() {
    this.clearWatchdog();
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

function researchPrompt(intent, project) {
  return `You are Flow Research Agent. Analyze this task intent for project "${project}":

**Task**: ${intent}

Provide:
1. Feasibility assessment (technical complexity, estimated effort)
2. Key risks and dependencies
3. Suggested approach (high-level)
4. Questions or ambiguities that need clarification

Be concise and structured.`;
}

function planPrompt(intent, codexResearch, claudeResearch) {
  return `You are Flow Planner. Based on the research below, create an implementation plan.

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

function reviewPrompt(plan, reviewer) {
  return `You are Flow ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer.
Review this plan critically. For each issue found, use severity tags [P0] [P1] [P2] [P3]:

- [P0] Critical: Will cause system failure or data loss
- [P1] High: Major functional defect or security vulnerability
- [P2] Medium: Performance issue, poor design, or missing edge case
- [P3] Low: Style, naming, or minor improvement

If the plan has no P2+ issues, respond with: "REVIEW: PASS"

**Plan to review**:
${plan}`;
}

function revisePrompt(plan, codexIssues, claudeIssues) {
  const allIssues = [...codexIssues, ...claudeIssues]
    .filter(i => i.severity >= 2)
    .map(i => `[P${i.severity}] ${i.description}`)
    .join("\n");

  return `You are Flow Plan Reviser. Revise this plan to address the issues below.

**Issues found by reviewers**:
${allIssues}

**Original plan**:
${plan}

Provide the revised plan as markdown, addressing each issue.`;
}

// --- Main review flow ---

async function runReview(flowRoot, sessionId) {
  const session = await getSession(flowRoot, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  let codex, claude;

  try {
    // Start persistent ACP connections (parallel)
    [codex, claude] = await Promise.all([
      new PersistentAcp("codex").start(),
      new PersistentAcp("claude").start(),
    ]);

    // Phase 1: Research (parallel, reuse connections)
    await updateSession(flowRoot, sessionId, { status: "researching" });
    const [codexResearch, claudeResearch] = await Promise.all([
      codex.sendPrompt(researchPrompt(session.intent, session.project)),
      claude.sendPrompt(researchPrompt(session.intent, session.project)),
    ]);
    await updateSession(flowRoot, sessionId, {
      research: { codex: codexResearch, claude: claudeResearch },
    });

    // Phase 2: Plan (reuse codex connection)
    await updateSession(flowRoot, sessionId, { status: "planning" });
    const plan = await codex.sendPrompt(planPrompt(session.intent, codexResearch, claudeResearch));
    await updateSession(flowRoot, sessionId, { plan });

    // Phase 3: Review Loop (max 5 rounds, reuse both connections)
    let currentPlan = plan;
    for (let round = 1; round <= 5; round++) {
      await updateSession(flowRoot, sessionId, { status: "reviewing", round });

      const [codexReview, claudeReview] = await Promise.all([
        codex.sendPrompt(reviewPrompt(currentPlan, "codex")),
        claude.sendPrompt(reviewPrompt(currentPlan, "claude")),
      ]);

      const codexIssues = parseIssues(codexReview);
      const claudeIssues = parseIssues(claudeReview);

      const reviews = (await getSession(flowRoot, sessionId)).reviews;
      await updateSession(flowRoot, sessionId, {
        reviews: [...reviews, { round, codex: codexReview, claude: claudeReview, codexIssues, claudeIssues }],
      });

      const hasP2 = [...codexIssues, ...claudeIssues].some((i) => i.severity >= 2);
      if (!hasP2) {
        await updateSession(flowRoot, sessionId, { status: "user_review" });
        console.log(`[review] session ${sessionId} passed review at round ${round}`);
        return;
      }

      if (round < 5) {
        await updateSession(flowRoot, sessionId, { status: "revising" });
        const revised = await codex.sendPrompt(revisePrompt(currentPlan, codexIssues, claudeIssues));
        currentPlan = revised;
        await updateSession(flowRoot, sessionId, { plan: revised });
      }
    }

    await updateSession(flowRoot, sessionId, { status: "expired" });
    console.log(`[review] session ${sessionId} expired after 5 rounds`);
  } catch (err) {
    console.error(`[review] session ${sessionId} error: ${err.message}`);
    try { await updateSession(flowRoot, sessionId, { status: "expired" }); } catch {}
  } finally {
    codex?.close();
    claude?.close();
  }
}

// CLI entry
const flowRoot = process.argv[2];
const sessionId = process.argv[3];
if (!flowRoot || !sessionId) {
  console.error("Usage: review-dispatch.mjs <flowRoot> <sessionId>");
  process.exit(1);
}

runReview(flowRoot, sessionId);
