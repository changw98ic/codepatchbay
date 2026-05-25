import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../cli/commands/evolve-multi.js";

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function restoreEnv(snapshot) {
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

describe("evolve-multi CLI environment boundary", () => {
  it("scrubs arbitrary parent secrets while preserving ACP orchestration env", async () => {
    await withTempRoot("cpb-evolve-env-", async (root) => {
      const cpbRoot = path.join(root, "cpb");
      const executorRoot = path.join(root, "executor");
      const capturePath = path.join(root, "capture.json");
      await mkdir(path.join(executorRoot, "bridges"), { recursive: true });
      await writeFile(path.join(executorRoot, "bridges", "multi-evolve.mjs"), `
        import { writeFileSync } from "node:fs";
        writeFileSync(process.argv[2], JSON.stringify({
          cpbRoot: process.env.CPB_ROOT || null,
          executorRoot: process.env.CPB_EXECUTOR_ROOT || null,
          hubRoot: process.env.CPB_HUB_ROOT || null,
          multiAgent: process.env.CPB_MULTI_EVOLVE_AGENT || null,
          timeoutMs: process.env.CPB_MULTI_EVOLVE_TIMEOUT_MS || null,
          providerKey: process.env.OPENAI_API_KEY || null,
          databaseUrl: process.env.DATABASE_URL || null,
          randomToken: process.env.RANDOM_TOKEN || null,
          webhookSecret: process.env.CPB_GITHUB_WEBHOOK_SECRET || null
        }));
      `, "utf8");

      const snapshot = {
        CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
        CPB_MULTI_EVOLVE_AGENT: process.env.CPB_MULTI_EVOLVE_AGENT,
        CPB_MULTI_EVOLVE_TIMEOUT_MS: process.env.CPB_MULTI_EVOLVE_TIMEOUT_MS,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        DATABASE_URL: process.env.DATABASE_URL,
        RANDOM_TOKEN: process.env.RANDOM_TOKEN,
        CPB_GITHUB_WEBHOOK_SECRET: process.env.CPB_GITHUB_WEBHOOK_SECRET,
      };
      try {
        process.env.CPB_HUB_ROOT = "/tmp/cpb-hub";
        process.env.CPB_MULTI_EVOLVE_AGENT = "claude";
        process.env.CPB_MULTI_EVOLVE_TIMEOUT_MS = "12345";
        process.env.OPENAI_API_KEY = "provider-secret";
        process.env.DATABASE_URL = "postgres://user:pass@example/db";
        process.env.RANDOM_TOKEN = "leak";
        process.env.CPB_GITHUB_WEBHOOK_SECRET = "webhook-secret";

        await run([capturePath], { cpbRoot, executorRoot });

        const payload = JSON.parse(await readFile(capturePath, "utf8"));
        assert.equal(payload.cpbRoot, cpbRoot);
        assert.equal(payload.executorRoot, executorRoot);
        assert.equal(payload.hubRoot, "/tmp/cpb-hub");
        assert.equal(payload.multiAgent, "claude");
        assert.equal(payload.timeoutMs, "12345");
        assert.equal(payload.providerKey, "provider-secret");
        assert.equal(payload.databaseUrl, null);
        assert.equal(payload.randomToken, null);
        assert.equal(payload.webhookSecret, null);
      } finally {
        restoreEnv(snapshot);
      }
    });
  });
});
