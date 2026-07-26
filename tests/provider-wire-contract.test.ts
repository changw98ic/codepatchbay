import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  _internalWriteProviderQuota,
  assertProviderAvailable,
  readProviderQuotas,
  withProviderQuotaPersistenceHooksForTests,
} from "../server/services/provider-quota.js";
import {
  _internalAppendUsageLine,
  readProviderUsage,
  readProviderUsageRollup,
  withProviderUsagePersistenceHooksForTests,
} from "../server/services/provider-usage.js";
import { tempRoot } from "./helpers.js";

test("provider quota diagnostics identify malformed canonical JSON", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-json-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "{bad json", "utf8");

  await assert.rejects(
    readProviderQuotas(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTAS_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /quotas\.json.*invalid JSON/i);
      return true;
    },
  );
});

test("provider quota validation preserves valid legacy records and extension fields", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-legacy-contract");
  const filePath = path.join(hubRoot, "providers", "rate-limits.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  const untilTs = "2027-01-02T03:04:05.000Z";
  const legacy = {
    legacy: {
      untilTs,
      reason: "old",
      metadata: { migratedFrom: "v0" },
    },
  };
  await writeFile(filePath, `${JSON.stringify(legacy)}\n`, "utf8");

  assert.deepEqual(await readProviderQuotas(hubRoot), {
    legacy: {
      ...legacy.legacy,
      providerKey: "legacy",
      agent: "legacy",
      status: "rate_limited",
      nextEligibleAt: Date.parse(untilTs),
      source: "legacy-rate-limits",
      confidence: 1,
    },
  });
});

test("provider quota validation rejects malformed legacy reset timestamps", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-legacy-invalid-contract");
  const filePath = path.join(hubRoot, "providers", "rate-limits.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ codex: { untilTs: "not-a-date" } })}\n`, "utf8");

  await assert.rejects(
    readProviderQuotas(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTA_ENTRY_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /rate-limits\.json.*untilTs/i);
      return true;
    },
  );
});

test("provider quota validation rejects entries without a status", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-status-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ codex: {} })}\n`, "utf8");

  await assert.rejects(
    readProviderQuotas(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTA_ENTRY_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /codex.*status/i);
      return true;
    },
  );
});

test("provider availability fails closed for unavailable states without a reset", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-no-reset-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    codex: { status: "rate_limited", reason: "provider supplied no reset" },
  })}\n`, "utf8");

  await assert.rejects(
    assertProviderAvailable(hubRoot, { providerKey: "codex", agent: "codex" }),
    (err: unknown) => {
      assert.equal((err as { status?: string }).status, "rate_limited");
      assert.match(String((err as Error).message), /provider supplied no reset/i);
      return true;
    },
  );
});

test("provider quota reads reject symlinked canonical files", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-symlink-contract");
  const providersDir = path.join(hubRoot, "providers");
  const filePath = path.join(providersDir, "quotas.json");
  const targetPath = path.join(providersDir, "target.json");
  await mkdir(providersDir, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify({ codex: { status: "available" } })}\n`, "utf8");
  await symlink(targetPath, filePath);

  await assert.rejects(
    readProviderQuotas(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTAS_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /no-follow|regular/i);
      return true;
    },
  );
});

test("provider quota reads reject oversized canonical files", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-oversize-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `{"codex":{"status":"available","padding":"${"x".repeat(1024 * 1024)}"}}\n`, "utf8");

  await assert.rejects(
    readProviderQuotas(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_QUOTAS_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /bounded read limit/i);
      return true;
    },
  );
});

test("provider quota reads fail closed when the file grows during bounded read", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-growth-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ codex: { status: "available" } })}\n`, "utf8");
  await withProviderQuotaPersistenceHooksForTests({
    readHooks: {
      afterOpen: async () => {
        await writeFile(filePath, `${JSON.stringify({ codex: { status: "available" }, next: { status: "available" } })}\n`, "utf8");
      },
    },
  }, async () => {
    await assert.rejects(
      readProviderQuotas(hubRoot),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "PROVIDER_QUOTAS_CONTRACT_INVALID");
        assert.match(String((err as Error).message), /changed|bounded read limit/i);
        return true;
      },
    );
  });
});

test("provider quota persistence hooks stay isolated across concurrent reads", async () => {
  const failingHubRoot = await tempRoot("cpb-provider-quota-hook-scope-failing");
  const healthyHubRoot = await tempRoot("cpb-provider-quota-hook-scope-healthy");
  const failingPath = path.join(failingHubRoot, "providers", "quotas.json");
  const healthyPath = path.join(healthyHubRoot, "providers", "quotas.json");
  await Promise.all([
    mkdir(path.dirname(failingPath), { recursive: true }),
    mkdir(path.dirname(healthyPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(failingPath, `${JSON.stringify({ codex: { status: "available" } })}\n`, "utf8"),
    writeFile(healthyPath, `${JSON.stringify({ codex: { status: "available" } })}\n`, "utf8"),
  ]);
  const injected = Object.assign(new Error("scoped quota read failure"), { code: "EIO" });

  const [failing, healthy] = await Promise.allSettled([
    withProviderQuotaPersistenceHooksForTests({
      readHooks: { afterOpen: async () => { throw injected; } },
    }, () => readProviderQuotas(failingHubRoot)),
    readProviderQuotas(healthyHubRoot),
  ]);

  assert.equal(failing.status, "rejected");
  assert.equal(healthy.status, "fulfilled");
  if (healthy.status === "fulfilled") assert.equal(healthy.value.codex.status, "available");
});

test("provider quota publication preserves successor files on source-generation races", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-successor-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  const retiredPath = path.join(hubRoot, "providers", "quotas.retired.json");
  const successor = { successor: { status: "available", reason: "new owner" } };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ codex: { status: "available" } })}\n`, "utf8");
  await withProviderQuotaPersistenceHooksForTests({
    beforeRename: async () => {
      await rename(filePath, retiredPath);
      await writeFile(filePath, `${JSON.stringify(successor)}\n`, "utf8");
    },
  }, async () => {
    await assert.rejects(
      _internalWriteProviderQuota(hubRoot, "codex", { status: "rate_limited", reason: "old writer" }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "PROVIDER_QUOTAS_SOURCE_CHANGED");
        assert.equal((err as { committed?: boolean }).committed, false);
        assert.deepEqual((err as { recoveryPaths?: string[] }).recoveryPaths?.slice(0, 1), [filePath]);
        return true;
      },
    );
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), successor);
  });
});

test("provider quota failure cleanup never unlinks a replacement temporary generation", async () => {
  const hubRoot = await tempRoot("cpb-provider-quota-temp-successor-contract");
  const filePath = path.join(hubRoot, "providers", "quotas.json");
  const retiredTemp = path.join(hubRoot, "providers", "quota-temp-predecessor.json");
  const successor = "temporary successor must remain\n";
  const injected = Object.assign(new Error("stop before provider quota publication"), { code: "EIO" });
  let tempPath = "";
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ codex: { status: "available" } })}\n`, "utf8");
  await withProviderQuotaPersistenceHooksForTests({
    beforeRename: async (context) => {
      tempPath = context.tempPath;
      await rename(context.tempPath, retiredTemp);
      await writeFile(context.tempPath, successor, "utf8");
      throw injected;
    },
  }, async () => {
    await assert.rejects(
      _internalWriteProviderQuota(hubRoot, "codex", { status: "rate_limited", reason: "old writer" }),
      (error: unknown) => {
        const failure = error as Error & {
          code?: string;
          committed?: boolean;
          recoveryPaths?: string[];
        };
        assert.equal(failure.code, "EIO");
        assert.equal(failure.committed, false);
        assert.ok(failure.recoveryPaths?.includes(tempPath));
        return true;
      },
    );
    assert.ok(tempPath);
    assert.equal(await readFile(tempPath, "utf8"), successor);
    assert.match(await readFile(retiredTemp, "utf8"), /"rate_limited"/);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).codex.status, "available");
  });
});

test("provider usage diagnostics identify the malformed JSONL line", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-line-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, [
    JSON.stringify({ providerKey: "codex", status: "ok", usage: { calls: 1, totalTokens: 12 } }),
    JSON.stringify({ providerKey: "codex", status: "ok", usage: { calls: "many" } }),
    "",
  ].join("\n"), "utf8");

  await assert.rejects(
    readProviderUsageRollup(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_USAGE_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /usage\.jsonl.*line 2/i);
      return true;
    },
  );
});

test("provider usage validation preserves valid rollup semantics", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-valid-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, [
    JSON.stringify({
      providerKey: "codex",
      agent: "codex",
      status: "ok",
      durationMs: 9,
      usage: { calls: 2, totalTokens: 24, costUsd: 0.03, tokenSource: "native" },
      extension: { retained: true },
    }),
    JSON.stringify({
      providerKey: "codex",
      status: "error",
      usage: { calls: 1, totalTokens: null, costUsd: null, tokenSource: "not_reported" },
    }),
    "",
  ].join("\n"), "utf8");

  const rollup = await readProviderUsageRollup(hubRoot);
  assert.equal(rollup.codex.calls, 2);
  assert.equal(rollup.codex.ok, 1);
  assert.equal(rollup.codex.errors, 1);
  assert.equal(rollup.codex.llmCalls, 3);
  assert.equal(rollup.codex.reportedTokens, 24);
  assert.equal(rollup.codex.tokens, null);
  assert.equal(rollup.codex.tokenCoverage, 2 / 3);
  assert.equal(rollup.codex.reportedCostUsd, 0.03);
  assert.equal(rollup.codex.costUsd, null);
  assert.equal(rollup.codex.totalDurationMs, 9);
});

test("provider usage append validates before poisoning the durable log", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-append-contract");

  await assert.rejects(
    _internalAppendUsageLine(hubRoot, {
      providerKey: "codex",
      status: "ok",
      usage: { calls: "many" },
    }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_USAGE_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /usage\.jsonl.*append/i);
      return true;
    },
  );
  assert.deepEqual(await readProviderUsage(hubRoot), []);
});

test("provider usage reads reject symlinked JSONL logs", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-symlink-contract");
  const providersDir = path.join(hubRoot, "providers");
  const filePath = path.join(providersDir, "usage.jsonl");
  const targetPath = path.join(providersDir, "target.jsonl");
  await mkdir(providersDir, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`, "utf8");
  await symlink(targetPath, filePath);

  await assert.rejects(
    readProviderUsage(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_USAGE_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /no-follow|regular/i);
      return true;
    },
  );
});

test("provider usage reads reject oversized JSONL logs", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-oversize-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ providerKey: "codex", status: "ok", padding: "x".repeat(4 * 1024 * 1024) })}\n`, "utf8");

  await assert.rejects(
    readProviderUsage(hubRoot),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PROVIDER_USAGE_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /bounded read limit/i);
      return true;
    },
  );
});

test("provider usage retries a transient growing log and returns the complete stable snapshot", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-growth-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`, "utf8");
  let grew = false;
  const records = await withProviderUsagePersistenceHooksForTests({
    readHooks: {
      afterOpen: async () => {
        if (grew) return;
        grew = true;
        await writeFile(filePath, [
          JSON.stringify({ providerKey: "codex", status: "ok" }),
          JSON.stringify({ providerKey: "other", status: "ok" }),
          "",
        ].join("\n"), "utf8");
      },
    },
  }, () => readProviderUsage(hubRoot));

  assert.equal(grew, true);
  assert.deepEqual(records.map((record) => record.providerKey), ["codex", "other"]);
});

test("provider usage bounds retries when the log never reaches a stable generation", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-persistent-growth-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`, "utf8");
  let attempts = 0;

  await assert.rejects(
    withProviderUsagePersistenceHooksForTests({
      readHooks: {
        afterOpen: async () => {
          attempts += 1;
          await writeFile(filePath, Array.from({ length: attempts + 1 }, (_, index) => (
            JSON.stringify({ providerKey: `provider-${index}`, status: "ok" })
          )).join("\n") + "\n", "utf8");
        },
      },
    }, () => readProviderUsage(hubRoot)),
    (err: unknown) => {
      const failure = err as { code?: string; attempts?: number };
      assert.equal(failure.code, "PROVIDER_USAGE_READ_UNSTABLE");
      assert.equal(failure.attempts, attempts);
      assert.ok(attempts >= 2 && attempts <= 10);
      assert.match(String((err as Error).message), /stable.*attempt/i);
      return true;
    },
  );
});

test("provider usage persistence hooks are isolated across concurrent reads", async () => {
  const unstableRoot = await tempRoot("cpb-provider-usage-hook-unstable");
  const stableRoot = await tempRoot("cpb-provider-usage-hook-stable");
  const unstablePath = path.join(unstableRoot, "providers", "usage.jsonl");
  const stablePath = path.join(stableRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(unstablePath), { recursive: true });
  await mkdir(path.dirname(stablePath), { recursive: true });
  await writeFile(unstablePath, `${JSON.stringify({ providerKey: "unstable", status: "ok" })}\n`, "utf8");
  await writeFile(stablePath, `${JSON.stringify({ providerKey: "stable", status: "ok" })}\n`, "utf8");
  let attempts = 0;

  const [unstable, stable] = await Promise.allSettled([
    withProviderUsagePersistenceHooksForTests({
      readHooks: {
        afterOpen: async ({ filePath }) => {
          attempts += 1;
          await writeFile(filePath, `${JSON.stringify({ providerKey: `unstable-${attempts}`, status: "ok" })}\n`, "utf8");
        },
      },
    }, () => readProviderUsage(unstableRoot)),
    readProviderUsage(stableRoot),
  ]);

  assert.equal(unstable.status, "rejected");
  assert.equal((unstable as PromiseRejectedResult).reason.code, "PROVIDER_USAGE_READ_UNSTABLE");
  assert.equal(stable.status, "fulfilled");
  assert.deepEqual((stable as PromiseFulfilledResult<Array<{ providerKey: string }>>).value.map((record) => record.providerKey), ["stable"]);
});

test("provider usage append preserves successor logs on source-generation races", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-successor-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  const retiredPath = path.join(hubRoot, "providers", "usage.retired.jsonl");
  const successorLine = JSON.stringify({ providerKey: "successor", status: "ok" });
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`, "utf8");
  await withProviderUsagePersistenceHooksForTests({
    beforeAppendOpen: async () => {
      await rename(filePath, retiredPath);
      await writeFile(filePath, `${successorLine}\n`, "utf8");
    },
  }, async () => {
    await assert.rejects(
      _internalAppendUsageLine(hubRoot, { providerKey: "codex", status: "ok", mutationId: "m1", commandDigest: "d1" }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "PROVIDER_USAGE_SOURCE_CHANGED");
        assert.equal((err as { committed?: boolean }).committed, false);
        assert.deepEqual((err as { recoveryPaths?: string[] }).recoveryPaths?.slice(0, 1), [filePath]);
        return true;
      },
    );
    assert.equal(await readFile(filePath, "utf8"), `${successorLine}\n`);
  });
});

test("provider usage append detects same-inode source-generation ABA", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-source-aba-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  const original = `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, original, "utf8");
  const before = await stat(filePath);

  await withProviderUsagePersistenceHooksForTests({
    beforeAppendOpen: async () => {
      await writeFile(filePath, original, "utf8");
      assert.equal((await stat(filePath)).ino, before.ino);
      assert.notEqual((await stat(filePath)).ctimeMs, before.ctimeMs);
    },
  }, async () => {
    await assert.rejects(
      _internalAppendUsageLine(hubRoot, { providerKey: "other", status: "ok" }),
      (err: unknown) => (err as { code?: string }).code === "PROVIDER_USAGE_SOURCE_CHANGED",
    );
  });
  assert.equal(await readFile(filePath, "utf8"), original);
});

test("provider usage append revalidates the source generation after opening", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-open-source-race-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  const retiredPath = path.join(hubRoot, "providers", "usage.opened.jsonl");
  const original = `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`;
  const successor = `${JSON.stringify({ providerKey: "successor", status: "ok" })}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, original, "utf8");

  await withProviderUsagePersistenceHooksForTests({
    afterAppendOpen: async () => {
      await rename(filePath, retiredPath);
      await writeFile(filePath, successor, "utf8");
    },
  }, async () => {
    await assert.rejects(
      _internalAppendUsageLine(hubRoot, { providerKey: "other", status: "ok" }),
      (err: unknown) => (err as { code?: string }).code === "PROVIDER_USAGE_SOURCE_CHANGED",
    );
  });
  assert.equal(await readFile(retiredPath, "utf8"), original);
  assert.equal(await readFile(filePath, "utf8"), successor);
});

test("provider usage append reports the canonical committed path after a post-write failure", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-append-committed-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");

  await assert.rejects(
    withProviderUsagePersistenceHooksForTests({
      afterAppendWrite: async () => {
        throw Object.assign(new Error("file sync fault after append"), { code: "EIO" });
      },
    }, () => _internalAppendUsageLine(hubRoot, { providerKey: "codex", status: "ok" })),
    (err: unknown) => {
      const failure = err as {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        recoveryPaths?: string[];
      };
      assert.equal(failure.code, "PROVIDER_USAGE_APPEND_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, filePath);
      assert.ok(failure.recoveryPaths?.includes(filePath));
      return true;
    },
  );
  assert.deepEqual((await readProviderUsage(hubRoot)).map((record) => record.providerKey), ["codex"]);
});

test("provider usage append reports an unknown committed path when a successor replaces it after write", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-post-write-successor-contract");
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  const retiredPath = path.join(hubRoot, "providers", "usage.committed.jsonl");
  const successor = `${JSON.stringify({ providerKey: "successor", status: "ok" })}\n`;

  await assert.rejects(
    withProviderUsagePersistenceHooksForTests({
      afterAppendWrite: async () => {
        await rename(filePath, retiredPath);
        await writeFile(filePath, successor, "utf8");
      },
    }, () => _internalAppendUsageLine(hubRoot, { providerKey: "codex", status: "ok" })),
    (err: unknown) => {
      const failure = err as {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        recoveryPaths?: string[];
      };
      assert.equal(failure.code, "PROVIDER_USAGE_APPEND_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, null);
      assert.ok(failure.recoveryPaths?.includes(filePath));
      return true;
    },
  );
  assert.match(await readFile(retiredPath, "utf8"), /"providerKey":"codex"/);
  assert.equal(await readFile(filePath, "utf8"), successor);
});

test("provider usage append revalidates the canonical path after directory sync", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-post-sync-successor-contract");
  const providersDir = path.join(hubRoot, "providers");
  const filePath = path.join(providersDir, "usage.jsonl");
  const retiredPath = path.join(providersDir, "usage.synced.jsonl");
  const successor = `${JSON.stringify({ providerKey: "successor", status: "ok" })}\n`;

  await assert.rejects(
    withProviderUsagePersistenceHooksForTests({
      beforeDirectorySync: async ({ phase }) => {
        if (phase !== "after-append") return;
        await rename(filePath, retiredPath);
        await writeFile(filePath, successor, "utf8");
      },
    }, () => _internalAppendUsageLine(hubRoot, { providerKey: "codex", status: "ok" })),
    (err: unknown) => {
      const failure = err as {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        canonicalFileIdentity?: { ino?: number } | null;
      };
      assert.equal(failure.code, "PROVIDER_USAGE_APPEND_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, null);
      assert.ok(failure.canonicalFileIdentity);
      return true;
    },
  );
  assert.match(await readFile(retiredPath, "utf8"), /"providerKey":"codex"/);
  assert.equal(await readFile(filePath, "utf8"), successor);
});

test("provider usage rejects a symlinked providers directory without touching its target", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-parent-symlink-contract");
  const externalRoot = await tempRoot("cpb-provider-usage-parent-symlink-target");
  const externalFile = path.join(externalRoot, "usage.jsonl");
  const externalContent = `${JSON.stringify({ providerKey: "external", status: "ok" })}\n`;
  await writeFile(externalFile, externalContent, "utf8");
  await symlink(externalRoot, path.join(hubRoot, "providers"), "dir");

  await assert.rejects(
    readProviderUsage(hubRoot),
    (err: unknown) => (err as { code?: string }).code === "PROVIDER_USAGE_DIRECTORY_UNSAFE",
  );
  await assert.rejects(
    _internalAppendUsageLine(hubRoot, { providerKey: "codex", status: "ok" }),
    (err: unknown) => (err as { code?: string }).code === "PROVIDER_USAGE_DIRECTORY_UNSAFE",
  );
  assert.equal(await readFile(externalFile, "utf8"), externalContent);
});

test("provider usage append rejects a providers-directory swap before opening the log", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-parent-swap-contract");
  const providersDir = path.join(hubRoot, "providers");
  const retiredProviders = path.join(hubRoot, "providers.retired");
  const filePath = path.join(providersDir, "usage.jsonl");
  const externalRoot = await tempRoot("cpb-provider-usage-parent-swap-target");
  const externalFile = path.join(externalRoot, "usage.jsonl");
  const original = `${JSON.stringify({ providerKey: "codex", status: "ok" })}\n`;
  const externalContent = `${JSON.stringify({ providerKey: "external", status: "ok" })}\n`;
  await mkdir(providersDir, { recursive: true });
  await writeFile(filePath, original, "utf8");
  await writeFile(externalFile, externalContent, "utf8");

  await assert.rejects(
    withProviderUsagePersistenceHooksForTests({
      beforeAppendOpen: async () => {
        await rename(providersDir, retiredProviders);
        await symlink(externalRoot, providersDir, "dir");
      },
    }, () => _internalAppendUsageLine(hubRoot, { providerKey: "other", status: "ok" })),
    (err: unknown) => (err as { code?: string }).code === "PROVIDER_USAGE_DIRECTORY_UNSAFE",
  );
  assert.equal(await readFile(path.join(retiredProviders, "usage.jsonl"), "utf8"), original);
  assert.equal(await readFile(externalFile, "utf8"), externalContent);
});
