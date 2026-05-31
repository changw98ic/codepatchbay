import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const ACP_PATH = path.resolve(import.meta.dirname, "../../bridges/browser-agent-acp.mjs");

describe("acp-adapter: browser-agent-acp.mjs JSON-RPC over stdio", () => {
  it("handles initialize → session/new → session/prompt → session/close lifecycle", async () => {
    const child = spawn(process.execPath, [ACP_PATH], {
      env: {
        ...process.env,
        CPB_ACP_BROWSER_AGENT_PROVIDER: "mock",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          stdoutLines.push(JSON.parse(line));
        } catch {
          stdoutLines.push({ raw: line });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    function send(msg) {
      return new Promise((resolve) => {
        child.stdin.write(JSON.stringify(msg) + "\n", () => resolve());
      });
    }

    function waitFor(methodFilter, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          const matches = stdoutLines.filter(methodFilter);
          if (matches.length > 0) {
            clearInterval(timer);
            resolve(matches);
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`timeout waiting for method`));
          }
        }, 50);
      });
    }

    try {
      // 1. initialize
      await send({ jsonrpc: "2.0", id: 1, method: "initialize" });
      const initResponses = await waitFor((m) => m.id === 1, 5000);
      assert.equal(initResponses[0].jsonrpc, "2.0");
      assert.equal(initResponses[0].id, 1);
      assert.ok(initResponses[0].result);
      assert.equal(initResponses[0].result.protocolVersion, 1);
      assert.equal(initResponses[0].result.agentInfo.name, "browser-agent");

      // 2. session/new
      await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
      const sessionResponses = await waitFor((m) => m.id === 2, 5000);
      assert.ok(sessionResponses[0].result.sessionId);
      const sessionId = sessionResponses[0].result.sessionId;
      assert.match(sessionId, /^browser-/);

      // 3. session/prompt — send a simple prompt
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: '{"status":"ok","message":"browser-agent-ready"}' }],
        },
      });

      // Wait for streamed session/update notifications and final response
      const finalResponse = await new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          // Look for final id=3 response
          const final = stdoutLines.find((m) => m.id === 3 && Object.hasOwn(m, "result"));
          if (final) {
            clearInterval(timer);
            resolve(final);
          }
          if (Date.now() - start > 20000) {
            clearInterval(timer);
            reject(new Error("timeout waiting for final prompt response"));
          }
        }, 50);
      });

      assert.equal(finalResponse.jsonrpc, "2.0");
      assert.equal(finalResponse.id, 3);
      assert.equal(finalResponse.result, null);

      // Verify we got streamed chunks
      const chunks = stdoutLines.filter(
        (m) =>
          m.method === "session/update" &&
          m.params?.update?.sessionUpdate === "agent_message_chunk"
      );
      assert.ok(chunks.length > 0, "expected at least one streamed chunk");

      // Verify final accumulated text makes sense
      const fullText = chunks.map((c) => c.params.update.content.text).join("");
      assert.ok(
        fullText.includes("status") || fullText.includes("browser-agent-ready") || fullText.length > 0,
        `expected non-empty response text, got: ${fullText.slice(0, 200)}`
      );

      // 4. session/close
      await send({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId } });
      const closeResponses = await waitFor((m) => m.id === 4, 5000);
      assert.equal(closeResponses[0].result, null);
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.on("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  });
});
