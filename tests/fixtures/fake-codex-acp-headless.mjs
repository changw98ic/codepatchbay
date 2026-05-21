#!/usr/bin/env node
/**
 * Fake codex-acp agent for headless process-tree acceptance tests (issue #62).
 *
 * Records all received args + a deterministic process-tree marker showing
 * whether Computer Use MCP would be mounted.  Acts as a minimal ACP agent
 * (initialize → session/new → session/prompt).
 *
 * Env vars:
 *   CPB_HEADLESS_ARGS_MARKER   — file to write raw args JSON (default /tmp/cpb-headless-args-test.txt)
 *   CPB_HEADLESS_PROCESS_TREE  — file to write process-tree marker JSON (default /tmp/cpb-headless-process-tree.txt)
 */
import readline from "node:readline";
import { writeFileSync } from "node:fs";

const MARKER = process.env.CPB_HEADLESS_ARGS_MARKER || "/tmp/cpb-headless-args-test.txt";
const PT_FILE = process.env.CPB_HEADLESS_PROCESS_TREE || "/tmp/cpb-headless-process-tree.txt";

// ── Record args ──────────────────────────────────────────────
const args = process.argv.slice(2);
writeFileSync(MARKER, JSON.stringify(args));

// ── Process-tree marker ──────────────────────────────────────
const REQUIRED_PATTERNS = [
  { pattern: "computer-use", desc: "computer-use disabled" },
  { pattern: "browser",      desc: "browser disabled" },
  { pattern: "chrome",       desc: "chrome disabled" },
  { pattern: "notify=[]",    desc: "notify hooks disabled" },
];

const missingOverrides = REQUIRED_PATTERNS.filter(
  ({ pattern }) => !args.some((a) => a.includes(pattern)),
);
const hasSkyComputerUse = args.some((a) => a.includes("SkyComputerUseClient"));

writeFileSync(PT_FILE, JSON.stringify({
  pid: process.pid,
  children: [],
  skyComputerUseClientMcp: hasSkyComputerUse,
  missingOverrides: missingOverrides.map(({ desc }) => desc),
  allOverridesPresent: missingOverrides.length === 0,
}));

// ── Minimal ACP agent ────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-codex-acp-headless", version: "0.0.0" },
        authMethods: [],
      },
    });
  } else if (msg.method === "session/new") {
    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "headless-pt-session" } });
  } else if (msg.method === "session/prompt") {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "headless-pt-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "HEADLESS_PROCESS_TREE_DONE" },
        },
      },
    });
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
