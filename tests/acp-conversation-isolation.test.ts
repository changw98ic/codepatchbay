import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  clearSessionId,
  cleanupSessionCache,
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

test("session cache isolates explicit data roots under one cpbRoot without persisting dataRoot", async () => {
  const tmp = await tempRoot("cpb-session-data-root-cache");
  const cpbRoot = path.join(tmp, "cpb");
  const dataRootA = path.join(tmp, "runtime-a");
  const dataRootB = path.join(tmp, "runtime-b");

  await saveSessionId(cpbRoot, "browser-agent", "session-a", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  });
  await saveSessionId(cpbRoot, "browser-agent", "session-b", {
    dataRoot: dataRootB,
    conversationKey: "same-conversation",
  });

  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  }))?.sessionId, "session-a");
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootB,
    conversationKey: "same-conversation",
  }))?.sessionId, "session-b");
  assert.equal(await loadSessionId(cpbRoot, "browser-agent", {
    conversationKey: "same-conversation",
  }), null);

  const cacheFiles = await readdir(path.join(dataRootA, "session-cache"));
  const cacheJson = cacheFiles.find((file) => file.endsWith(".json"));
  assert.ok(cacheJson);
  const cacheRecord = JSON.parse(await readFile(path.join(
    dataRootA,
    "session-cache",
    cacheJson,
  ), "utf8"));
  assert.equal(Object.hasOwn(cacheRecord, "dataRoot"), false);

  await clearSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  });
  assert.equal(await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  }), null);
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootB,
    conversationKey: "same-conversation",
  }))?.sessionId, "session-b");

  await saveSessionId(cpbRoot, "browser-agent", "session-a-2", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  });
  assert.equal(await cleanupSessionCache(cpbRoot, { dataRoot: dataRootA, maxAgeMs: -1 }), 1);
  assert.equal(await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  }), null);
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootB,
    conversationKey: "same-conversation",
  }))?.sessionId, "session-b");
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
  assert.notEqual(
    poolClientKey("fake-acp", {
      projectId: "proj",
      dataRoot: "/tmp/cpb-runtime-a",
      conversationKey: "same-conversation",
    }),
    poolClientKey("fake-acp", {
      projectId: "proj",
      dataRoot: "/tmp/cpb-runtime-b",
      conversationKey: "same-conversation",
    }),
  );
  assert.notEqual(
    poolClientKey("fake-acp", { projectId: "proj", dataRoot: "/tmp/cpb-runtime-a" }),
    poolClientKey("fake-acp", { projectId: "proj", dataRoot: "/tmp/cpb-runtime-b" }),
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

test("persistent ACP clients isolate cached sessions by explicit dataRoot", async () => {
  const tmp = await tempRoot("cpb-acp-data-root-pool");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRootA = path.join(tmp, "runtime-a");
  const dataRootB = path.join(tmp, "runtime-b");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(scenarioPath, JSON.stringify({
    responses: [{ output: "data-root-response" }],
  }), "utf8");
  await saveSessionId(cpbRoot, "browser-agent", "resume-from-root-a", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_PROJECT_RUNTIME_ROOT: dataRootA,
      CPB_ACP_BROWSER_AGENT_COMMAND: process.execPath,
      CPB_ACP_BROWSER_AGENT_ARGS: JSON.stringify([
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
      phase: "verify",
      role: "verifier",
      conversationKey: "same-conversation",
    };
    const first = await pool.execute("browser-agent", "root a prompt", repoRoot, 10_000, {
      ...baseOptions,
      jobId: "job-a",
    });
    const second = await pool.execute("browser-agent", "root b prompt", repoRoot, 10_000, {
      ...baseOptions,
      jobId: "job-b",
      dataRoot: dataRootB,
    });
    const third = await pool.execute("browser-agent", "root a explicit follow-up", repoRoot, 10_000, {
      ...baseOptions,
      jobId: "job-a-follow-up",
      dataRoot: dataRootA,
    });

    assert.equal(first.sessionId, "resume-from-root-a");
    assert.equal(second.sessionId, "test-session");
    assert.equal(third.sessionId, "resume-from-root-a");
    assert.equal(pool.persistentClients.size, 2);

    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/resume").length, 1);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 1);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, 3);
  } finally {
    await pool.stop();
  }

  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootA,
    conversationKey: "same-conversation",
  }))?.sessionId, "resume-from-root-a");
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", {
    dataRoot: dataRootB,
    conversationKey: "same-conversation",
  }))?.sessionId, "test-session");
});
