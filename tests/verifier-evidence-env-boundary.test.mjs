import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectTestResults } from "../server/services/verifier-evidence.js";

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

describe("verifier evidence environment boundary", () => {
  it("scrubs arbitrary parent secrets before running project tests", async () => {
    await withTempRoot("cpb-verifier-env-", async (root) => {
      const projectDir = path.join(root, "project");
      const binDir = path.join(root, "bin");
      await mkdir(projectDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
        scripts: { test: "node ignored-by-fake-npm.js" },
      }), "utf8");

      const fakeNpm = path.join(binDir, "npm");
      await writeFile(fakeNpm, `#!/usr/bin/env node
console.log(JSON.stringify({
  path: process.env.PATH || null,
  projectRuntimeRoot: process.env.CPB_PROJECT_RUNTIME_ROOT || null,
  databaseUrl: process.env.DATABASE_URL || null,
  randomToken: process.env.RANDOM_TOKEN || null,
  webhookSecret: process.env.CPB_GITHUB_WEBHOOK_SECRET || null,
  providerKey: process.env.OPENAI_API_KEY || null
}));
`, "utf8");
      await chmod(fakeNpm, 0o755);

      const snapshot = {
        PATH: process.env.PATH,
        CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
        DATABASE_URL: process.env.DATABASE_URL,
        RANDOM_TOKEN: process.env.RANDOM_TOKEN,
        CPB_GITHUB_WEBHOOK_SECRET: process.env.CPB_GITHUB_WEBHOOK_SECRET,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      };
      try {
        process.env.PATH = `${binDir}${path.delimiter}${snapshot.PATH || ""}`;
        process.env.CPB_PROJECT_RUNTIME_ROOT = "/tmp/cpb-runtime";
        process.env.DATABASE_URL = "postgres://user:pass@example/db";
        process.env.RANDOM_TOKEN = "leak";
        process.env.CPB_GITHUB_WEBHOOK_SECRET = "webhook-secret";
        process.env.OPENAI_API_KEY = "provider-secret";

        const result = await collectTestResults(projectDir, { timeout: 5_000 });

        assert.equal(result.available, true);
        const payload = JSON.parse(result.stdout.trim().split(/\n/).pop());
        assert.match(payload.path, new RegExp(`^${binDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.equal(payload.projectRuntimeRoot, "/tmp/cpb-runtime");
        assert.equal(payload.databaseUrl, null);
        assert.equal(payload.randomToken, null);
        assert.equal(payload.webhookSecret, null);
        assert.equal(payload.providerKey, null);
      } finally {
        restoreEnv(snapshot);
      }
    });
  });
});
