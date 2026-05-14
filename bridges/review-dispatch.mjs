#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { createSession, getSession, updateSession, parseIssues } from "../server/services/review-session.js";

const CPB_ROOT = path.resolve(".");
const PROTOCOL_VERSION = 1;
const ACP_STUCK_MS = parseInt(process.env.ACP_STUCK_MS || "300000", 10);

// --- Persistent ACP connection ---

function commandExists(cmd) {
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd]).status === 0;
}

function resolveAgentCommand(agent) {
  const upper = agent.toUpperCase();
  const envCmd = process.env[`CPB_ACP_${upper}_COMMAND`];
  if (envCmd) {
    const envArgs = process.env[`CPB_ACP_${upper}_ARGS`];
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
      const cache = path.join(tmpdir(), `cpb-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdir(cache, { recursive: true });
      env.npm_config_cache = cache;
    }

    this.child = spawn(command, args, {
      cwd: CPB_ROOT,
      env: { ...env, CPB_ROOT },
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
      clientInfo: { name: "cpb-review", title: "CodePatchbay Review", version: "0.1.0" },
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

    const session = await this.request("session/new", { cwd: CPB_ROOT, mcpServers: [] });

    let response = "";
    const startedAt = Date.now();
    let lastTextAt = Date.now();
    const STUCK_MS = parseInt(process.env.ACP_PROMPT_STUCK_MS || "300000", 10);
    const MAX_MS = parseInt(process.env.ACP_PROMPT_MAX_MS || "600000", 10);

    const collectUpdate = (params) => {
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.type === "text") {
        response += update.content.text;
        lastTextAt = Date.now();
      }
    };

    let stuckTimer = null;
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
    this.handleClientRequest = async (msg) => {
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
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
        stuckGuard,
      ]);

      await this.request("session/close", { sessionId: session.sessionId }).catch(() => null);
    } catch (err) {
      console.error(`[${this.agent}] sendPrompt error: ${err.message}`);
      try {
        this.write({ jsonrpc: "2.0", method: "session/close", params: { sessionId: session.sessionId } });
      } catch {}
      throw err;
    } finally {
      clearInterval(stuckTimer);
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

  async restart() {
    this.close();
    this.closed = false;
    this.pending.clear();
    this.nextId = 1;
    return this.start();
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
  return `You are CodePatchbay Research Agent. Analyze this task intent for project "${project}":

**Task**: ${intent}

Provide:
1. Feasibility assessment (technical complexity, estimated effort)
2. Key risks and dependencies
3. Suggested approach (high-level)
4. Questions or ambiguities that need clarification

Be concise and structured.`;
}

function planPrompt(intent, codexResearch, claudeResearch) {
  return `You are CodePatchbay Planner. Based on the research below, create an implementation plan.

Skills: Read skill files from ${CPB_ROOT}/profiles/codex/skills/ as needed.

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
  const skillDir = reviewer === "codex" ? "codex" : "reviewer";
  return `You are CodePatchbay ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer.

Skills: Read skill files from ${CPB_ROOT}/profiles/${skillDir}/skills/ as needed.

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

  return `You are CodePatchbay Plan Reviser. Revise this plan to address the issues below.

**Issues found by reviewers**:
${allIssues}

**Original plan**:
${plan}

Provide the revised plan as markdown, addressing each issue.`;
}

// --- Main review cpb ---

const MAX_RETRIES = parseInt(process.env.ACP_MAX_RETRIES || "2", 10);

async function sendWithRetry(acp, prompt, agent, retries = MAX_RETRIES) {
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

async function runReview(cpbRoot, sessionId) {
  const session = await getSession(cpbRoot, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  let codex, claude;

  try {
    [codex, claude] = await Promise.all([
      new PersistentAcp("codex").start(),
      new PersistentAcp("claude").start(),
    ]);

    // Phase 1: Research
    await updateSession(cpbRoot, sessionId, { status: "researching" });
    console.log(`[review] ${sessionId} phase 1: researching`);
    const [codexRes, claudeRes] = await Promise.allSettled([
      sendWithRetry(codex, researchPrompt(session.intent, session.project), "codex"),
      sendWithRetry(claude, researchPrompt(session.intent, session.project), "claude"),
    ]);
    const codexResearch = codexRes.status === "fulfilled" ? codexRes.value : "";
    const claudeResearch = claudeRes.status === "fulfilled" ? claudeRes.value : "";
    if (!codexResearch && !claudeResearch) throw new Error("both research agents failed");
    await updateSession(cpbRoot, sessionId, {
      research: { codex: codexResearch, claude: claudeResearch },
    });

    // Phase 2: Plan
    await updateSession(cpbRoot, sessionId, { status: "planning" });
    console.log(`[review] ${sessionId} phase 2: planning`);
    const plan = await sendWithRetry(codex, planPrompt(session.intent, codexResearch, claudeResearch), "codex");
    await updateSession(cpbRoot, sessionId, { plan });

    // Phase 3: Review Loop (max 5 rounds)
    let currentPlan = plan;
    for (let round = 1; round <= 5; round++) {
      await updateSession(cpbRoot, sessionId, { status: "reviewing", round });
      console.log(`[review] ${sessionId} round ${round}: reviewing`);

      const results = await Promise.allSettled([
        sendWithRetry(codex, reviewPrompt(currentPlan, "codex"), "codex"),
        sendWithRetry(claude, reviewPrompt(currentPlan, "claude"), "claude"),
      ]);

      const codexReview = results[0].status === "fulfilled" ? results[0].value : "";
      const claudeReview = results[1].status === "fulfilled" ? results[1].value : "";
      if (results[0].status === "rejected") console.error(`[review] codex review failed: ${results[0].reason?.message}`);
      if (results[1].status === "rejected") console.error(`[review] claude review failed: ${results[1].reason?.message}`);
      if (!codexReview && !claudeReview) throw new Error("both reviewers failed");

      const codexIssues = parseIssues(codexReview);
      const claudeIssues = parseIssues(claudeReview);

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

      if (round < 5) {
        await updateSession(cpbRoot, sessionId, { status: "revising" });
        console.log(`[review] ${sessionId} revising for round ${round + 1}`);
        const revised = await sendWithRetry(codex, revisePrompt(currentPlan, codexIssues, claudeIssues), "codex");
        currentPlan = revised;
        await updateSession(cpbRoot, sessionId, { plan: revised });
      }
    }

    await updateSession(cpbRoot, sessionId, { status: "expired" });
    console.log(`[review] ${sessionId} expired after 5 rounds`);
  } catch (err) {
    console.error(`[review] ${sessionId} error: ${err.message}`);
    try { await updateSession(cpbRoot, sessionId, { status: "expired" }); } catch {}
  } finally {
    codex?.close();
    claude?.close();
  }
}

// CLI entry
const cpbRoot = process.argv[2];
const sessionId = process.argv[3];
if (!cpbRoot || !sessionId) {
  console.error("Usage: review-dispatch.mjs <cpbRoot> <sessionId>");
  process.exit(1);
}

runReview(cpbRoot, sessionId);
