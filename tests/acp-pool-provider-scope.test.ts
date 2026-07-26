import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { AcpPool } from "../server/services/acp/acp-pool.js";
import { tempRoot } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testAgent = path.join(repoRoot, "tests", "fixtures", "test-acp-agent.js");

async function readJsonl(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Defense-in-depth lock on the persistent-client reuse path (#getPersistentClient).
// poolClientKey is agent+conversation-scoped and does NOT encode providerKey, so a
// same-agent + same-conversation request carrying a DIFFERENT providerKey would
// otherwise reuse the cached persistent client (wrong provider's session). The
// guard closes the stale client and respawns. Default handoff (agent+variant+
// providerKey all change together) already misses the key — covered by
// acp-conversation-isolation.test.ts.

test("AcpPool does not reuse a persistent client when providerKey differs (defense-in-depth)", async () => {
  const tmp = await tempRoot("cpb-acp-provider-scope");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "r1" }, { output: "r2" }] }),
    "utf8",
  );

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
    const base = {
      projectId: "proj",
      phase: "execute",
      role: "executor",
      jobId: "job-1",
      conversationKey: "same-conv",
    };
    await pool.execute("fake-acp", "first", repoRoot, 10_000, { ...base, providerKey: "pk-alpha" });
    await pool.execute("fake-acp", "second", repoRoot, 10_000, { ...base, providerKey: "pk-beta" });

    const transcript = await readJsonl(transcriptPath);
    const inits = transcript.filter((e) => e.event === "initialize").length;
    // Different providerKey, same agent + conversation -> must NOT reuse the
    // cached persistent client; a fresh client is spawned (2 initialize events).
    assert.equal(inits, 2);
  } finally {
    await pool.stop();
  }
});

test("AcpPool still reuses a persistent client when providerKey matches (no false positive)", async () => {
  const tmp = await tempRoot("cpb-acp-provider-scope-reuse");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "r1" }, { output: "r2" }] }),
    "utf8",
  );

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
    const base = {
      projectId: "proj",
      phase: "execute",
      role: "executor",
      jobId: "job-1",
      conversationKey: "same-conv",
      providerKey: "pk-same",
    };
    await pool.execute("fake-acp", "first", repoRoot, 10_000, base);
    await pool.execute("fake-acp", "second", repoRoot, 10_000, base);

    const transcript = await readJsonl(transcriptPath);
    const inits = transcript.filter((e) => e.event === "initialize").length;
    // Same providerKey + same conversation -> reuse is correct (1 initialize).
    assert.equal(inits, 1);
  } finally {
    await pool.stop();
  }
});
