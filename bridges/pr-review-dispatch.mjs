#!/usr/bin/env node

import { spawn, execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const CPB_ROOT = path.resolve(".");
const PROTOCOL_VERSION = 1;

// --- Diff & meta fetching ---

async function fetchPrDiff(repo, prNumber) {
  const { stdout } = await execFile("gh", [
    "pr", "diff", String(prNumber), "--repo", repo,
  ], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function fetchPrMeta(repo, prNumber) {
  try {
    const { stdout } = await execFile("gh", [
      "pr", "view", String(prNumber), "--repo", repo,
      "--json", "title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,number",
    ], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}

// --- Persistent ACP connection (same pattern as review-dispatch) ---

function commandExists(cmd) {
  const result = spawn("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd]);
  return new Promise((resolve) => {
    result.on("close", (code) => resolve(code === 0));
  });
}

async function resolveAgentCommand(agent, env = process.env) {
  const upper = agent.toUpperCase();
  const envCmd = env[`CPB_ACP_${upper}_COMMAND`];
  if (envCmd) {
    const envArgs = env[`CPB_ACP_${upper}_ARGS`];
    return { command: envCmd, args: envArgs ? JSON.parse(envArgs) : [] };
  }
  if (agent === "codex") {
    return (await commandExists("codex-acp"))
      ? { command: "codex-acp", args: [] }
      : { command: "npx", args: ["-y", "@zed-industries/codex-acp"] };
  }
  return (await commandExists("claude-agent-acp"))
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
    this.sessionId = null;
  }

  async start() {
    const env = { ...process.env };
    const { command, args } = await resolveAgentCommand(this.agent, env);
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

    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "cpb-pr-review", title: "CodePatchbay PR Review", version: "0.1.0" },
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

    if (!this.sessionId) {
      const session = await this.request("session/new", { cwd: CPB_ROOT, mcpServers: [] });
      this.sessionId = session.sessionId;
    }

    let response = "";
    const startedAt = Date.now();
    let lastTextAt = Date.now();
    const STUCK_MS = 300_000;
    const MAX_MS = 600_000;

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
          reject(new Error(`${this.agent} prompt stuck`));
        }
      }, 15000);
    });

    const origHandle = this.handleClientRequest.bind(this);
    this.handleClientRequest = async (msg) => {
      if (msg.method === "session/update") {
        collectUpdate(msg.params);
        if (Object.hasOwn(msg, "id")) this.respond(msg.id, null);
      } else {
        origHandle(msg);
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
      if (Date.now() - this.lastActivity > 300_000) {
        this.close();
        for (const { reject } of this.pending.values()) {
          reject(new Error(`${this.agent} heartbeat timeout`));
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

// --- Prompt builder ---

function buildPrReviewPrompt(diff, meta, task) {
  const metaLines = [];
  if (meta.title) metaLines.push(`Title: ${meta.title}`);
  if (meta.author?.login) metaLines.push(`Author: ${meta.author.login}`);
  if (meta.baseRefName) metaLines.push(`Base: ${meta.baseRefName} → Head: ${meta.headRefName || "unknown"}`);
  if (meta.additions != null) metaLines.push(`+${meta.additions}/-${meta.deletions} across ${meta.changedFiles} files`);

  return `You are performing a **read-only code review** of a GitHub pull request.
Analyze the diff below and produce a structured review. Do NOT suggest writing any code.

## PR Metadata
${metaLines.join("\n") || "Not available"}

${meta.body ? `## Description\n${meta.body.slice(0, 2000)}\n` : ""}
${task ? `## Review Focus\n${task}\n` : ""}

## Diff
\`\`\`diff
${diff.split("\n").slice(0, 8000).join("\n")}
\`\`\`

Provide your review with:
1. A summary of what the PR does
2. Issues found (security, correctness, performance)
3. A clear verdict: "approved", "changes_requested", or "needs_discussion"

Format your response EXACTLY as:

VERDICT: <approved|changes_requested|needs_discussion>

## Summary
<one paragraph>

## Issues
For each issue, use severity tags:
- [P0] Critical: Will cause system failure, data loss, or security vulnerability
- [P1] Major: Functional defect or significant design problem
- [P2] Medium: Performance issue, missing edge case, or poor practice
- [P3] Low: Style, naming, or minor improvement

## Recommendation
<clear approve/reject advice>`;
}

// --- Optional GitHub comment posting ---

async function postReviewComment(repo, prNumber, reviewBody) {
  try {
    await execFile("gh", [
      "pr", "comment", String(prNumber),
      "--repo", repo,
      "--body", reviewBody,
    ], { maxBuffer: 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatReviewComment(reviewText, repo, prNumber) {
  const lines = [
    "### CodePatchbay PR Review",
    "",
    `Reviewing ${repo}#${prNumber}`,
    "",
  ];

  // Extract verdict
  const verdictMatch = reviewText.match(/VERDICT:\s*(\S+)/i);
  const verdict = verdictMatch ? verdictMatch[1] : "unknown";
  const icon = verdict === "approved" ? "**APPROVED**" : verdict === "changes_requested" ? "**CHANGES REQUESTED**" : "**NEEDS DISCUSSION**";
  lines.push(`**Verdict**: ${icon}`);
  lines.push("");

  // Extract summary (text between ## Summary and next ##)
  const summaryMatch = reviewText.match(/## Summary\s*\n([\s\S]*?)(?=\n## |\n$)/i);
  if (summaryMatch) {
    lines.push("#### Summary");
    lines.push(summaryMatch[1].trim());
    lines.push("");
  }

  // Extract issues
  const issuesMatch = reviewText.match(/## Issues\s*\n([\s\S]*?)(?=\n## |\n$)/i);
  if (issuesMatch && issuesMatch[1].trim()) {
    lines.push("#### Issues");
    lines.push(issuesMatch[1].trim());
    lines.push("");
  }

  // Extract recommendation
  const recMatch = reviewText.match(/## Recommendation\s*\n([\s\S]*?)$/i);
  if (recMatch) {
    lines.push("#### Recommendation");
    lines.push(recMatch[1].trim());
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by CodePatchbay PR Review*");

  return lines.join("\n");
}

// --- Main ---

async function main() {
  const repo = process.argv[2];
  const prNumber = process.argv[3];
  const outputDir = process.argv[4] || "";
  const shouldComment = process.argv[5] === "--post";
  const reviewFocus = process.argv[6] || "";

  if (!repo || !prNumber) {
    console.error("Usage: pr-review-dispatch.mjs <owner/repo> <pr-number> [output-dir] [--post] [focus]");
    process.exit(1);
  }

  console.log(`[pr-review] Fetching diff for ${repo}#${prNumber}`);

  let diff, meta;
  try {
    [diff, meta] = await Promise.all([
      fetchPrDiff(repo, prNumber),
      fetchPrMeta(repo, prNumber),
    ]);
  } catch (err) {
    console.error(`[pr-review] Failed to fetch PR data: ${err.message}`);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.error("[pr-review] PR diff is empty");
    process.exit(1);
  }

  console.log(`[pr-review] Diff fetched: ${diff.split("\n").length} lines`);

  const prompt = buildPrReviewPrompt(diff, meta, reviewFocus);

  let acp;
  const agent = process.env.CPB_PR_REVIEW_AGENT || "codex";
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      acp = new PersistentAcp(agent);
      await acp.start();
      break;
    } catch (err) {
      console.error(`[pr-review] ACP start attempt ${attempt + 1} failed: ${err.message}`);
      acp?.close();
      if (attempt === MAX_RETRIES) {
        console.error("[pr-review] Failed to start ACP agent");
        process.exit(1);
      }
    }
  }

  let reviewText;
  try {
    console.log(`[pr-review] Running review with ${agent}...`);
    reviewText = await acp.sendPrompt(prompt);
  } catch (err) {
    console.error(`[pr-review] Review failed: ${err.message}`);
    acp.close();
    process.exit(1);
  } finally {
    acp.close();
  }

  console.log(`[pr-review] Review completed: ${reviewText.length} chars`);

  // Save review artifact
  if (outputDir) {
    const id = `pr-${repo.replace(/\//g, "-")}-${prNumber}-${Date.now()}`;
    const reviewPath = path.join(outputDir, `review-${id}.md`);
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(reviewPath, `# PR Review: ${repo}#${prNumber}\n\n${reviewText}\n`, "utf8");
    console.log(`[pr-review] Review saved to ${reviewPath}`);
  }

  // Post to GitHub if requested
  if (shouldComment) {
    const commentBody = formatReviewComment(reviewText, repo, prNumber);
    const result = await postReviewComment(repo, prNumber, commentBody);
    if (result.ok) {
      console.log(`[pr-review] Review posted as comment on ${repo}#${prNumber}`);
    } else {
      console.error(`[pr-review] Failed to post comment: ${result.error}`);
    }
  }

  // Output result as JSON for programmatic consumption
  const verdictMatch = reviewText.match(/VERDICT:\s*(\S+)/i);
  const result = {
    repo,
    prNumber: Number(prNumber),
    verdict: verdictMatch ? verdictMatch[1].toLowerCase() : "unknown",
    review: reviewText,
    postedToGithub: shouldComment,
  };

  process.stdout.write("\n__PR_REVIEW_RESULT__\n");
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(`[pr-review] Fatal: ${err.message}`);
  process.exit(1);
});
