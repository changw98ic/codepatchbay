import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  clearSessionId,
  loadSessionId,
  saveSessionId,
} from "../core/agents/session-cache.js";
import { AcpPool, poolClientKey } from "../server/services/acp/acp-pool.js";
import { tempRoot } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testAgent = path.join(repoRoot, "tests", "fixtures", "test-acp-agent.js");

async function readJsonl(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("session cache isolates explicit conversation keys while preserving the legacy entry", async () => {
  const cpbRoot = await tempRoot("cpb-session-conversation-cache");

  await saveSessionId(cpbRoot, "browser-agent", "legacy-session");
  await saveSessionId(cpbRoot, "browser-agent", "attempt-one-session", {
    conversationKey: "job-1:attempt-1",
  });
  await saveSessionId(cpbRoot, "browser-agent", "attempt-two-session", {
    conversationKey: "job-1:attempt-2",
  });

  assert.equal((await loadSessionId(cpbRoot, "browser-agent"))?.sessionId, "legacy-session");
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    conversationKey: "job-1:attempt-1",
  }))?.sessionId, "attempt-one-session");
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    conversationKey: "job-1:attempt-2",
  }))?.sessionId, "attempt-two-session");
  assert.equal(await loadSessionId(cpbRoot, "browser-agent", {
    conversationKey: "job-1:attempt-3",
  }), null);

  await clearSessionId(cpbRoot, "browser-agent", { conversationKey: "job-1:attempt-1" });
  assert.equal(await loadSessionId(cpbRoot, "browser-agent", {
    conversationKey: "job-1:attempt-1",
  }), null);
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    conversationKey: "job-1:attempt-2",
  }))?.sessionId, "attempt-two-session");
  assert.equal((await loadSessionId(cpbRoot, "browser-agent"))?.sessionId, "legacy-session");
});

test("pool client keys preserve legacy reuse and isolate explicit conversations", () => {
  const legacy = poolClientKey("fake-acp", { projectId: "proj", workspaceId: "workspace" });
  assert.equal(
    legacy,
    poolClientKey("fake-acp", {
      projectId: "proj",
      workspaceId: "workspace",
      conversationKey: "",
    }),
  );
  assert.notEqual(
    poolClientKey("fake-acp", { projectId: "proj", conversationKey: "job-1:attempt-1" }),
    poolClientKey("fake-acp", { projectId: "proj", conversationKey: "job-1:attempt-2" }),
  );
});

test("persistent ACP clients never share a session across conversation keys", async () => {
  const tmp = await tempRoot("cpb-acp-conversation-pool");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "runtime");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify({
    responses: [{ output: "conversation-response" }],
  }), "utf8");

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      // The fake ACP transcript is an agent-owned diagnostic artifact. Declare
      // this test's exact temporary root instead of relying on a platform-wide
      // TMPDIR that is present on macOS but commonly unset on Linux.
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--scenario-file",
        scenarioPath,
        "--transcript-file",
        transcriptPath,
      ]),
    },
  });

  try {
    const baseOptions = {
      projectId: "proj",
      phase: "execute",
      role: "executor",
    };
    await pool.execute("fake-acp", "attempt one", repoRoot, 10_000, {
      ...baseOptions,
      jobId: "job-1",
      conversationKey: "job-1:attempt-1",
    });
    await pool.execute("fake-acp", "attempt two", repoRoot, 10_000, {
      ...baseOptions,
      jobId: "job-1",
      conversationKey: "job-1:attempt-2",
    });
    await pool.execute("fake-acp", "attempt one follow-up", repoRoot, 10_000, {
      ...baseOptions,
      jobId: "job-1",
      conversationKey: "job-1:attempt-1",
    });

    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, 3);
    assert.equal(pool.persistentClients.size, 2);
  } finally {
    await pool.stop();
  }
});
