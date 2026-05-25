import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob } from "../server/services/job-store.js";
import { dispatchPhase, resetHooksForTest } from "../server/services/phase-runner.js";

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("phase-runner environment boundary", () => {
  it("scrubs the job-runner wrapper env while preserving locators and lease tuning", async () => {
    await withTempRoot("cpb-phase-runner-env-", async (root) => {
      const cpbRoot = path.join(root, "cpb");
      const executorRoot = path.join(root, "executor");
      const project = "proj";
      const jobId = "job-1";

      await mkdir(path.join(cpbRoot, "wiki", "projects", project), { recursive: true });
      await mkdir(path.join(executorRoot, "bridges"), { recursive: true });
      await writeFile(path.join(executorRoot, "bridges", "job-runner.mjs"), `
        console.log(JSON.stringify({
          cpbRoot: process.env.CPB_ROOT || null,
          executorRoot: process.env.CPB_EXECUTOR_ROOT || null,
          provider: process.env.OPENAI_API_KEY || null,
          leaseTtl: process.env.CPB_LEASE_TTL_MS || null,
          leaseRenew: process.env.CPB_LEASE_RENEW_INTERVAL_MS || null,
          databaseUrl: process.env.DATABASE_URL || null,
          randomToken: process.env.RANDOM_TOKEN || null,
          webhookSecret: process.env.CPB_GITHUB_WEBHOOK_SECRET || null
        }));
      `, "utf8");

      resetHooksForTest();
      await createJob(cpbRoot, {
        project,
        jobId,
        task: "phase env boundary",
      });

      const result = await dispatchPhase(cpbRoot, {
        project,
        jobId,
        phase: "plan",
        script: "bridges/noop.mjs",
        executorRoot,
        env: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "provider-secret",
          CPB_LEASE_TTL_MS: "1234",
          CPB_LEASE_RENEW_INTERVAL_MS: "567",
          DATABASE_URL: "postgres://user:pass@example/db",
          RANDOM_TOKEN: "leak",
          CPB_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        },
      });

      assert.equal(result.exitCode, 0);
      const payload = JSON.parse(result.stdout.trim().split(/\n/).pop());
      assert.equal(payload.cpbRoot, path.resolve(cpbRoot));
      assert.equal(payload.executorRoot, path.resolve(executorRoot));
      assert.equal(payload.provider, "provider-secret");
      assert.equal(payload.leaseTtl, "1234");
      assert.equal(payload.leaseRenew, "567");
      assert.equal(payload.databaseUrl, null);
      assert.equal(payload.randomToken, null);
      assert.equal(payload.webhookSecret, null);
    });
  });
});
