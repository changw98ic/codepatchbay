import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AcpPool } from "../../server/services/acp/acp-pool.js";
import { redactSecrets } from "../../server/services/secret-policy.js";

const artifactRoot = path.resolve(import.meta.dirname, "../..");
const timeoutFromEnvironment = Number(process.env.CPB_LIVE_E2E_TIMEOUT_MS);
const providerTimeoutMs = Number.isFinite(timeoutFromEnvironment) && timeoutFromEnvironment > 0
  ? timeoutFromEnvironment
  : 5 * 60 * 1000;
const claudeAgent = process.env.CPB_LIVE_E2E_CLAUDE_AGENT || "claude";

if (!/^claude(?:-|$)/.test(claudeAgent)) {
  throw new Error("CPB_LIVE_E2E_CLAUDE_AGENT must select a registered Claude Code agent");
}

const providers = [
  { label: "Codex", agent: "codex" },
  { label: "Claude Code", agent: claudeAgent },
];

function safeProviderError(label: string, error: unknown) {
  const record = error && typeof error === "object" ? error as NodeJS.ErrnoException : null;
  const safe = redactSecrets({
    message: error instanceof Error ? error.message : String(error),
    code: record?.code || null,
  });
  return new Error(`${label} live provider execution failed: ${JSON.stringify(safe)}`);
}

async function readAuditEvents(auditFile: string) {
  const lines = (await readFile(auditFile, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as {
    event?: unknown;
    agent?: unknown;
    transport?: unknown;
  });
}

for (const provider of providers) {
  test(`${provider.label} edits a disposable workspace through the real CPB provider path`, {
    timeout: providerTimeoutMs + 30_000,
  }, async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), `cpb-live-${provider.agent}-`));
    const workspace = path.join(temporaryRoot, "workspace");
    const runtimeRoot = path.join(temporaryRoot, "runtime");
    const hubRoot = path.join(temporaryRoot, "hub");
    const proofFile = path.join(workspace, "provider-proof.txt");
    const expected = `cpb-live-e2e:${provider.agent}:${randomUUID()}\n`;
    const jobId = `live-${provider.agent}`.replace(/[^A-Za-z0-9_.-]/g, "-");
    const pool = new AcpPool({
      cpbRoot: artifactRoot,
      hubRoot,
      persistentProcesses: false,
      env: {
        ...process.env,
        CPB_ROOT: artifactRoot,
        CPB_HUB_ROOT: hubRoot,
        CPB_PROJECT_RUNTIME_ROOT: runtimeRoot,
        CPB_ACP_PERSISTENT_PROCESS: "0",
        CPB_ACP_POOL_WAIT_TIMEOUT_MS: String(providerTimeoutMs),
      },
    });

    await mkdir(workspace, { recursive: true });
    await writeFile(proofFile, "not yet verified\n", "utf8");

    const prompt = [
      "This is a live CodePatchBay end-to-end verification.",
      "Modify only provider-proof.txt in the current workspace.",
      `Replace its complete UTF-8 content with exactly this single line: ${expected.trimEnd()}`,
      "Keep the final newline. Do not run git and do not modify any other file.",
      "Use your real file-editing tool, then reply with DONE.",
    ].join("\n");

    try {
      let result: Awaited<ReturnType<AcpPool["execute"]>>;
      try {
        result = await pool.execute(provider.agent, prompt, workspace, providerTimeoutMs, {
          projectId: "live-e2e",
          jobId,
          dataRoot: runtimeRoot,
          phase: "execute",
          role: "executor",
          signal: AbortSignal.timeout(providerTimeoutMs),
          env: {
            CPB_ACP_WRITE_ALLOW: `${workspace}${path.sep}*`,
            CPB_ACP_PERMISSION: "allow",
            CPB_ACP_TERMINAL: "allow",
            CPB_ACP_PHASE_TIMEOUT_MS: String(providerTimeoutMs),
            CPB_ACP_IDLE_TIMEOUT_MS: String(Math.min(providerTimeoutMs, 2 * 60 * 1000)),
            CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "0",
            CPB_AGENT_ISOLATE_HOME: "1",
            CPB_AGENT_SANDBOX: "required",
            CPB_AGENT_SANDBOX_NETWORK: "allow",
            CPB_AGENT_SANDBOX_PROCESS: "allow",
          },
        });
      } catch (error) {
        throw safeProviderError(provider.label, error);
      }

      assert.equal(await readFile(proofFile, "utf8"), expected);
      assert.deepEqual(await readdir(workspace), ["provider-proof.txt"]);
      assert.equal(result.agent, provider.agent);
      assert.ok(result.providerKey, `${provider.label} did not report its provider identity`);
      assert.ok(result.acpAuditFile, `${provider.label} did not produce an ACP audit file`);

      const audit = await readAuditEvents(result.acpAuditFile as string);
      const launch = audit.find((entry) => (
        entry.event === "agent_launch" && entry.agent === provider.agent
      ));
      assert.ok(launch, `${provider.label} audit has no matching agent_launch event`);
      if (provider.label === "Claude Code") {
        assert.equal(launch.transport, "claude-cli");
      }
      assert.ok(
        audit.some((entry) => entry.event === "session_close" && entry.agent === provider.agent),
        `${provider.label} audit has no matching session_close event`,
      );
    } finally {
      await pool.stop();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
