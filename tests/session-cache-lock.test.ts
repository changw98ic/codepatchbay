import assert from "node:assert/strict";
import { constants } from "node:fs";
import { appendFile, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  cleanupSessionCache,
  clearSessionId,
  loadSessionId,
  saveSessionId,
  withSessionCacheTestHooks,
} from "../core/agents/session-cache.js";
import { tempRoot } from "./helpers.js";

function codedError(error: unknown, code: string): (Error & {
  code?: string;
  committed?: boolean;
  recoveryPaths?: string[];
  cleanupErrors?: unknown[];
}) | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown): ReturnType<typeof codedError> => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const candidate = value as Error & {
      code?: string;
      cause?: unknown;
      cleanupErrors?: unknown[];
      errors?: unknown[];
    };
    if (candidate.code === code) return candidate;
    for (const nested of [
      ...(candidate instanceof AggregateError ? candidate.errors : []),
      ...(Array.isArray(candidate.cleanupErrors) ? candidate.cleanupErrors : []),
      candidate.cause,
    ]) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(error);
}

test("session cache recovers an old incomplete legacy lock before writing", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-legacy-root");
  const dataRoot = await tempRoot("cpb-session-cache-legacy-data");
  const cacheDir = path.join(dataRoot, "session-cache");
  const lockDir = path.join(cacheDir, "browser-agent.lock");
  await mkdir(lockDir, { recursive: true });
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await saveSessionId(cpbRoot, "browser-agent", "recovered-session", { dataRoot });
  assert.equal((await loadSessionId(cpbRoot, "browser-agent", { dataRoot }))?.sessionId, "recovered-session");
});

test("session cache fails closed on corrupt JSON instead of silently dropping continuity", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-corrupt-root");
  const dataRoot = await tempRoot("cpb-session-cache-corrupt-data");
  const cacheDir = path.join(dataRoot, "session-cache");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, "browser-agent.json"), "{not-json\n");

  await assert.rejects(
    loadSessionId(cpbRoot, "browser-agent", { dataRoot }),
    { code: "SESSION_CACHE_INVALID" },
  );
});

test("session cache rejects symlinked records without touching the target", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-link-root");
  const dataRoot = await tempRoot("cpb-session-cache-link-data");
  const externalRoot = await tempRoot("cpb-session-cache-link-target");
  const cacheDir = path.join(dataRoot, "session-cache");
  const external = path.join(externalRoot, "session.json");
  const content = `${JSON.stringify({
    agent: "browser-agent",
    sessionId: "external",
    savedAt: new Date().toISOString(),
  })}\n`;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(external, content);
  await symlink(external, path.join(cacheDir, "browser-agent.json"));

  await assert.rejects(
    loadSessionId(cpbRoot, "browser-agent", { dataRoot }),
    { code: "SESSION_CACHE_UNSAFE" },
  );
  assert.equal(await readFile(external, "utf8"), content);
});

test("session cache clear rejects symlinked records without unlinking the evidence", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-clear-link-root");
  const dataRoot = await tempRoot("cpb-session-cache-clear-link-data");
  const externalRoot = await tempRoot("cpb-session-cache-clear-link-target");
  const cacheDir = path.join(dataRoot, "session-cache");
  const external = path.join(externalRoot, "session.json");
  const filePath = path.join(cacheDir, "browser-agent.json");
  const content = `${JSON.stringify({
    agent: "browser-agent",
    sessionId: "external",
    savedAt: new Date().toISOString(),
  })}\n`;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(external, content);
  await symlink(external, filePath);

  await assert.rejects(
    clearSessionId(cpbRoot, "browser-agent", { dataRoot }),
    { code: "SESSION_CACHE_UNSAFE" },
  );
  assert.equal((await lstat(filePath)).isSymbolicLink(), true);
  assert.equal(await readFile(external, "utf8"), content);
});

test("session cache bounded reads reject growth after the descriptor is pinned", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-growth-root");
  const dataRoot = await tempRoot("cpb-session-cache-growth-data");
  await saveSessionId(cpbRoot, "browser-agent", "initial-session", { dataRoot });
  let injected = false;

  await assert.rejects(
    withSessionCacheTestHooks({
      readFile: {
        afterOpen: async ({ filePath }: { filePath: string }) => {
          if (injected) return;
          injected = true;
          await appendFile(filePath, Buffer.alloc(1024 * 1024 + 1, 0x20));
        },
      },
    }, () => loadSessionId(cpbRoot, "browser-agent", { dataRoot })),
    { code: "SESSION_CACHE_UNSAFE" },
  );
  assert.equal(injected, true);
});

test("session cache bounded reads reject an already oversized record", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-oversized-root");
  const dataRoot = await tempRoot("cpb-session-cache-oversized-data");
  const filePath = path.join(dataRoot, "session-cache", "browser-agent.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 0x20));

  await assert.rejects(
    loadSessionId(cpbRoot, "browser-agent", { dataRoot }),
    { code: "SESSION_CACHE_UNSAFE" },
  );
});

test("session cache save refuses to publish a record that cannot be read within the bound", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-save-oversized-root");
  const dataRoot = await tempRoot("cpb-session-cache-save-oversized-data");
  const filePath = path.join(dataRoot, "session-cache", "browser-agent.json");

  await assert.rejects(
    saveSessionId(cpbRoot, "browser-agent", "too-large", {
      dataRoot,
      oversized: "x".repeat(1024 * 1024),
    }),
    { code: "SESSION_CACHE_TOO_LARGE" },
  );
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});

test("session cache rejects agent path traversal", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-agent-root");
  await assert.rejects(
    saveSessionId(cpbRoot, "../escape", "session"),
    { code: "SESSION_CACHE_AGENT_INVALID" },
  );
});

test("session cache metadata cannot overwrite continuity identity fields", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-meta-root");
  const dataRoot = await tempRoot("cpb-session-cache-meta-data");
  await saveSessionId(cpbRoot, "browser-agent", "trusted-session", {
    dataRoot,
    conversationKey: "job-1",
    agent: "attacker",
    sessionId: "attacker-session",
    savedAt: "not-a-date",
    format: "attacker-format",
    generation: "attacker-generation",
  });

  const loaded = await loadSessionId(cpbRoot, "browser-agent", { dataRoot, conversationKey: "job-1" });
  assert.equal(loaded?.agent, "browser-agent");
  assert.equal(loaded?.sessionId, "trusted-session");
  assert.ok(loaded?.savedAt && !Number.isNaN(Date.parse(String(loaded.savedAt))));
  assert.equal(loaded?.format, "cpb-session-cache/v1");
  assert.match(String(loaded?.generation), /^[a-f0-9-]{36}$/);
  assert.notEqual(loaded?.generation, "attacker-generation");
});

test("session cache cleanup fails closed on corrupt expired records", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-corrupt-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-corrupt-data");
  const cacheDir = path.join(dataRoot, "session-cache");
  const filePath = path.join(cacheDir, "browser-agent.json");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(filePath, "{not-json\n", "utf8");
  const old = new Date(0);
  await utimes(filePath, old, old);

  await assert.rejects(
    cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 }),
    { code: "SESSION_CACHE_INVALID" },
  );
  assert.equal(await readFile(filePath, "utf8"), "{not-json\n");
});

test("session cache cleanup rejects records whose owner does not match their cache path", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-owner-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-owner-data");
  const cacheDir = path.join(dataRoot, "session-cache");
  const filePath = path.join(cacheDir, "browser-agent.json");
  const content = `${JSON.stringify({
    agent: "different-agent",
    sessionId: "foreign-session",
    savedAt: new Date(0).toISOString(),
  })}\n`;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(filePath, content, "utf8");

  await assert.rejects(
    cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 }),
    { code: "SESSION_CACHE_INVALID" },
  );
  assert.equal(await readFile(filePath, "utf8"), content);
});

test("session cache cleanup preserves a canonical successor installed before isolation", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-successor-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-successor-data");
  const filePath = path.join(dataRoot, "session-cache", "browser-agent.json");
  const predecessorPath = `${filePath}.predecessor-evidence`;
  await saveSessionId(cpbRoot, "browser-agent", "expired-predecessor", { dataRoot });
  const successor = `${JSON.stringify({
    format: "cpb-session-cache/v1",
    generation: "11111111-1111-4111-8111-111111111111",
    agent: "browser-agent",
    sessionId: "live-successor",
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  let hookRan = false;

  await assert.rejects(
    withSessionCacheTestHooks({
      beforeRemovalIsolation: async ({ canonicalPath, phase }: { canonicalPath: string; phase: string }) => {
        if (phase !== "cleanup-remove" || hookRan) return;
        hookRan = true;
        await rename(canonicalPath, predecessorPath);
        await writeFile(canonicalPath, successor, "utf8");
      },
    }, () => cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 })),
    (error) => {
      assert.equal((error as { code?: string }).code, "SESSION_CACHE_REMOVE_GENERATION_CONFLICT");
      assert.equal((error as { committed?: boolean }).committed, false);
      return true;
    },
  );
  assert.equal(hookRan, true);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).sessionId, "live-successor");
  assert.equal(JSON.parse(await readFile(predecessorPath, "utf8")).sessionId, "expired-predecessor");
});

test("session cache cleanup preserves a same-owner quarantine successor after validation", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-quarantine-aba-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-quarantine-aba-data");
  await saveSessionId(cpbRoot, "browser-agent", "expired-predecessor", { dataRoot });
  let quarantinePath = "";
  let replacementRaw = "";

  await assert.rejects(
    withSessionCacheTestHooks({
      afterRemovalValidation: async ({ isolatedPath, phase }: { isolatedPath: string; phase: string }) => {
        if (phase !== "cleanup-remove" || quarantinePath) return;
        quarantinePath = isolatedPath;
        const predecessor = JSON.parse(await readFile(isolatedPath, "utf8"));
        replacementRaw = `${JSON.stringify({ ...predecessor, marker: "same-owner-successor" }, null, 2)}\n`;
        await rm(isolatedPath);
        await writeFile(isolatedPath, replacementRaw, "utf8");
      },
    }, () => cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 })),
    (error) => {
      const actual = error as { code?: string; committed?: boolean; recoveryPaths?: string[] };
      assert.equal(actual.code, "SESSION_CACHE_REMOVE_GENERATION_CONFLICT");
      assert.equal(actual.committed, true);
      assert.ok(actual.recoveryPaths?.includes(quarantinePath));
      return true;
    },
  );
  assert.ok(quarantinePath);
  assert.equal(await readFile(quarantinePath, "utf8"), replacementRaw);
  assert.ok((await readdir(path.dirname(quarantinePath))).includes(path.basename(quarantinePath)));
});

test("session cache cleanup never pathname-deletes a canonical successor after isolation", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-canonical-aba-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-canonical-aba-data");
  const filePath = path.join(dataRoot, "session-cache", "browser-agent.json");
  await saveSessionId(cpbRoot, "browser-agent", "expired-predecessor", { dataRoot });
  const successor = `${JSON.stringify({
    format: "cpb-session-cache/v1",
    generation: "22222222-2222-4222-8222-222222222222",
    agent: "browser-agent",
    sessionId: "canonical-successor",
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  let installed = false;

  const cleaned = await withSessionCacheTestHooks({
    afterRemovalValidation: async ({ canonicalPath, phase }: { canonicalPath: string; phase: string }) => {
      if (phase !== "cleanup-remove" || installed) return;
      installed = true;
      await writeFile(canonicalPath, successor, "utf8");
    },
  }, () => cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 }));

  assert.equal(cleaned, 1);
  assert.equal(installed, true);
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).sessionId, "canonical-successor");
});

test("session cache cleanup binds the post-isolation file to its full ctime generation", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-ctime-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-ctime-data");
  await saveSessionId(cpbRoot, "browser-agent", "expired-predecessor", { dataRoot });
  let isolatedPath = "";
  let originalRaw = "";

  await assert.rejects(
    withSessionCacheTestHooks({
      afterRemovalValidation: async (context) => {
        if (context.phase !== "cleanup-remove" || isolatedPath) return;
        isolatedPath = context.isolatedPath;
        originalRaw = await readFile(isolatedPath, "utf8");
        const before = await stat(isolatedPath);
        const originalMode = before.mode & 0o777;
        await chmod(isolatedPath, originalMode ^ 0o040);
        await chmod(isolatedPath, originalMode);
        const after = await stat(isolatedPath);
        assert.notEqual(after.ctimeMs, before.ctimeMs, "test mutation must advance ctime");
        assert.equal(after.size, before.size);
        assert.equal(after.mtimeMs, before.mtimeMs);
      },
    }, () => cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 })),
    (error) => {
      const actual = error as { code?: string; committed?: boolean; recoveryPaths?: string[] };
      assert.equal(actual.code, "SESSION_CACHE_REMOVE_GENERATION_CONFLICT");
      assert.equal(actual.committed, true);
      assert.ok(actual.recoveryPaths?.includes(isolatedPath));
      return true;
    },
  );
  assert.equal(await readFile(isolatedPath, "utf8"), originalRaw);
});

test("session cache save reports committed durability ambiguity with recovery paths", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-save-sync-root");
  const dataRoot = await tempRoot("cpb-session-cache-save-sync-data");
  const filePath = path.join(dataRoot, "session-cache", "browser-agent.json");
  const syncFailure = Object.assign(new Error("session parent sync unsupported"), { code: "ENOTSUP" });

  await assert.rejects(
    withSessionCacheTestHooks({
      syncDirectory: async (_directory: string, phase: string) => {
        if (phase === "write-commit") throw syncFailure;
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "committed-session", { dataRoot })),
    (error) => {
      assert.equal((error as { committed?: boolean }).committed, true);
      assert.ok((error as { recoveryPaths?: string[] }).recoveryPaths?.includes(filePath));
      const ambiguity = codedError(error, "SESSION_CACHE_COMMITTED_AMBIGUOUS");
      assert.ok(ambiguity);
      assert.equal(ambiguity.committed, true);
      assert.ok(ambiguity.recoveryPaths?.includes(filePath));
      assert.ok(ambiguity.recoveryPaths?.includes(path.dirname(filePath)));
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).sessionId, "committed-session");
});

test("session cache clear preserves isolated recovery evidence when quarantine durability is ambiguous", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-clear-isolate-sync-root");
  const dataRoot = await tempRoot("cpb-session-cache-clear-isolate-sync-data");
  const filePath = path.join(dataRoot, "session-cache", "browser-agent.json");
  const syncFailure = Object.assign(new Error("session isolation parent sync failed"), { code: "EIO" });
  await saveSessionId(cpbRoot, "browser-agent", "preserve-me", { dataRoot });
  let isolatedPath = "";

  await assert.rejects(
    withSessionCacheTestHooks({
      syncDirectory: async (_directory: string, phase: string) => {
        if (phase === "clear-isolate") throw syncFailure;
      },
    }, () => clearSessionId(cpbRoot, "browser-agent", { dataRoot })),
    (error) => {
      const actual = error as { code?: string; committed?: boolean; recoveryPaths?: string[] };
      assert.equal(actual.code, "SESSION_CACHE_REMOVE_ISOLATED_AMBIGUOUS");
      assert.equal(actual.committed, true);
      isolatedPath = actual.recoveryPaths?.find((candidate) => candidate.endsWith(".recovery")) || "";
      assert.ok(isolatedPath);
      return true;
    },
  );
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(isolatedPath, "utf8")).sessionId, "preserve-me");
});

test("session cache cleanup attempts every expired removal and aggregates durability ambiguity", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-cleanup-sync-root");
  const dataRoot = await tempRoot("cpb-session-cache-cleanup-sync-data");
  const cacheDir = path.join(dataRoot, "session-cache");
  const firstPath = path.join(cacheDir, "agent-a.json");
  const secondPath = path.join(cacheDir, "agent-b.json");
  await saveSessionId(cpbRoot, "agent-a", "session-a", { dataRoot });
  await saveSessionId(cpbRoot, "agent-b", "session-b", { dataRoot });
  let syncAttempts = 0;

  await assert.rejects(
    withSessionCacheTestHooks({
      syncDirectory: async (_directory: string, phase: string) => {
        if (phase !== "cleanup-isolate") return;
        syncAttempts += 1;
        throw Object.assign(new Error(`cleanup sync failed ${syncAttempts}`), { code: "EIO" });
      },
    }, () => cleanupSessionCache(cpbRoot, { dataRoot, maxAgeMs: -1 })),
    (error) => {
      assert.equal((error as { committed?: boolean }).committed, true);
      const aggregate = codedError(error, "SESSION_CACHE_CLEANUP_FAILED");
      assert.ok(aggregate);
      assert.equal(aggregate.committed, true);
      assert.equal(aggregate.cleanupErrors?.length, 2);
      assert.ok(aggregate.recoveryPaths?.includes(firstPath));
      assert.ok(aggregate.recoveryPaths?.includes(secondPath));
      return true;
    },
  );
  assert.equal(syncAttempts, 2);
  await assert.rejects(readFile(firstPath), { code: "ENOENT" });
  await assert.rejects(readFile(secondPath), { code: "ENOENT" });
});

test("session cache directory fsync uses strict no-follow directory flags", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-strict-directory-root");
  const dataRoot = await tempRoot("cpb-session-cache-strict-directory-data");
  const observedFlags: number[] = [];

  await withSessionCacheTestHooks({
    openDirectory: async (directory, flags) => {
      observedFlags.push(flags);
      return open(directory, flags);
    },
  }, () => saveSessionId(cpbRoot, "browser-agent", "strict-directory", { dataRoot }));

  assert.ok(observedFlags.length > 0);
  for (const flags of observedFlags) {
    assert.notEqual(flags & constants.O_NOFOLLOW, 0);
    assert.notEqual(flags & constants.O_DIRECTORY, 0);
  }
});

test("session cache rejects an untrusted symlink in the data-root chain before publication", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-parent-link-root");
  const linkParent = await tempRoot("cpb-session-cache-parent-link-parent");
  const externalRoot = await tempRoot("cpb-session-cache-parent-link-target");
  const dataRoot = path.join(linkParent, "linked-data-root");
  await symlink(externalRoot, dataRoot, "dir");

  await assert.rejects(
    saveSessionId(cpbRoot, "browser-agent", "must-not-publish", { dataRoot }),
    { code: "SESSION_CACHE_DIRECTORY_UNSAFE" },
  );
  await assert.rejects(lstat(path.join(externalRoot, "session-cache")), { code: "ENOENT" });
});

test("session cache clear preserves the isolated generation as recovery evidence", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-clear-preserve-root");
  const dataRoot = await tempRoot("cpb-session-cache-clear-preserve-data");
  const directory = path.join(dataRoot, "session-cache");
  const canonicalPath = path.join(directory, "browser-agent.json");
  await saveSessionId(cpbRoot, "browser-agent", "preserved-clear", { dataRoot });

  await clearSessionId(cpbRoot, "browser-agent", { dataRoot });

  await assert.rejects(readFile(canonicalPath), { code: "ENOENT" });
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  const recoveryName = entries.find((entry) => (
    entry.startsWith(".browser-agent.json.clear-remove.") && entry.endsWith(".recovery")
  ));
  assert.ok(recoveryName);
  assert.equal(
    JSON.parse(await readFile(path.join(directory, recoveryName), "utf8")).sessionId,
    "preserved-clear",
  );
});

test("session cache hard-link publication never overwrites a canonical successor", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-publish-successor-root");
  const dataRoot = await tempRoot("cpb-session-cache-publish-successor-data");
  const directory = path.join(dataRoot, "session-cache");
  const canonicalPath = path.join(directory, "browser-agent.json");
  await saveSessionId(cpbRoot, "browser-agent", "predecessor", { dataRoot });
  const successor = `${JSON.stringify({
    format: "cpb-session-cache/v1",
    generation: "33333333-3333-4333-8333-333333333333",
    agent: "browser-agent",
    sessionId: "canonical-successor",
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  let hookRan = false;

  await assert.rejects(
    withSessionCacheTestHooks({
      beforeWritePublish: async ({ filePath }) => {
        if (hookRan) return;
        hookRan = true;
        await writeFile(filePath, successor, { encoding: "utf8", flag: "wx" });
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "replacement", { dataRoot })),
    (error) => {
      const conflict = codedError(error, "SESSION_CACHE_PUBLISH_CONFLICT") as (Error & {
        publicationCommitted?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
      }) | null;
      assert.ok(conflict);
      assert.equal(conflict.publicationCommitted, false);
      assert.equal(conflict.successorPreserved, true);
      assert.ok(conflict.recoveryPaths?.includes(canonicalPath));
      return true;
    },
  );
  assert.equal(hookRan, true);
  assert.equal(await readFile(canonicalPath, "utf8"), successor);
  assert.ok((await readdir(directory)).some((entry) => entry.includes("write-replace") && entry.endsWith(".recovery")));
});

test("session cache revalidates the published generation after directory fsync", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-post-sync-successor-root");
  const dataRoot = await tempRoot("cpb-session-cache-post-sync-successor-data");
  const directory = path.join(dataRoot, "session-cache");
  const canonicalPath = path.join(directory, "browser-agent.json");
  const publishedEvidence = path.join(directory, "published-before-sync.recovery");
  const successor = `${JSON.stringify({
    format: "cpb-session-cache/v1",
    generation: "44444444-4444-4444-8444-444444444444",
    agent: "browser-agent",
    sessionId: "post-sync-successor",
    savedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  let hookRan = false;

  await assert.rejects(
    withSessionCacheTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase !== "write-commit" || hookRan) return;
        hookRan = true;
        await rename(canonicalPath, publishedEvidence);
        await writeFile(canonicalPath, successor, { encoding: "utf8", flag: "wx" });
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "published-predecessor", { dataRoot })),
    (error) => {
      const conflict = codedError(error, "SESSION_CACHE_PUBLISH_GENERATION_CONFLICT") as (Error & {
        publicationCommitted?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
      }) | null;
      assert.ok(conflict);
      assert.equal(conflict.publicationCommitted, true);
      assert.equal(conflict.successorPreserved, true);
      assert.ok(conflict.recoveryPaths?.includes(canonicalPath));
      assert.ok(conflict.recoveryPaths?.includes(publishedEvidence) || conflict.recoveryPaths?.includes(directory));
      return true;
    },
  );
  assert.equal(hookRan, true);
  assert.equal(await readFile(canonicalPath, "utf8"), successor);
  assert.equal(JSON.parse(await readFile(publishedEvidence, "utf8")).sessionId, "published-predecessor");
});

test("session cache update publishes the new generation and preserves the predecessor", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-update-root");
  const dataRoot = await tempRoot("cpb-session-cache-update-data");
  const directory = path.join(dataRoot, "session-cache");
  await saveSessionId(cpbRoot, "browser-agent", "first-session", { dataRoot });

  await saveSessionId(cpbRoot, "browser-agent", "second-session", { dataRoot });

  assert.equal((await loadSessionId(cpbRoot, "browser-agent", { dataRoot }))?.sessionId, "second-session");
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  const predecessorName = entries.find((entry) => (
    entry.startsWith(".browser-agent.json.write-replace.") && entry.endsWith(".recovery")
  ));
  assert.ok(predecessorName);
  assert.equal(
    JSON.parse(await readFile(path.join(directory, predecessorName), "utf8")).sessionId,
    "first-session",
  );
});

test("session cache publication hooks stay isolated across concurrent operations", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-hook-scope-root");
  const failingDataRoot = await tempRoot("cpb-session-cache-hook-scope-failing");
  const healthyDataRoot = await tempRoot("cpb-session-cache-hook-scope-healthy");
  const injected = Object.assign(new Error("scoped publication stop"), { code: "EIO" });

  const [failing, healthy] = await Promise.allSettled([
    withSessionCacheTestHooks({
      beforeWritePublish: async () => { throw injected; },
    }, () => saveSessionId(cpbRoot, "browser-agent", "must-fail", { dataRoot: failingDataRoot })),
    saveSessionId(cpbRoot, "browser-agent", "must-succeed", { dataRoot: healthyDataRoot }),
  ]);

  assert.equal(failing.status, "rejected");
  if (failing.status === "rejected") {
    const failure = failing.reason as {
      committed?: boolean;
      cleanupCommitted?: boolean;
      cleanupCommittedPath?: string;
      recoveryPaths?: string[];
    };
    assert.equal(failure.committed, false);
    assert.equal(failure.cleanupCommitted, true);
    assert.ok(failure.cleanupCommittedPath?.endsWith(".recovery"));
    assert.ok(failure.recoveryPaths?.includes(failure.cleanupCommittedPath!));
  }
  assert.equal(healthy.status, "fulfilled");
  assert.equal(
    (await loadSessionId(cpbRoot, "browser-agent", { dataRoot: healthyDataRoot }))?.sessionId,
    "must-succeed",
  );
});

test("session cache temp retirement preserves a competing isolated successor", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-temp-retire-successor-root");
  const dataRoot = await tempRoot("cpb-session-cache-temp-retire-successor-data");
  const directory = path.join(dataRoot, "session-cache");
  const canonicalPath = path.join(directory, "browser-agent.json");
  let isolatedPath = "";
  let predecessorEvidence = "";
  const successor = `${JSON.stringify({ marker: "temp-retire-successor" })}\n`;

  await assert.rejects(
    withSessionCacheTestHooks({
      beforePublishedTempRemoval: async (context) => {
        isolatedPath = context.isolatedPath;
        predecessorEvidence = `${isolatedPath}.predecessor-evidence`;
        await rename(isolatedPath, predecessorEvidence);
        await writeFile(isolatedPath, successor, "utf8");
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "published-session", { dataRoot })),
    (error) => {
      const outer = error as Error & {
        code?: string;
        committed?: boolean;
        cleanupCommitted?: boolean;
        successorPreserved?: boolean;
      };
      assert.equal(outer.code, "SESSION_CACHE_COMMITTED_AMBIGUOUS");
      assert.equal(outer.committed, true);
      assert.equal(outer.cleanupCommitted, true);
      assert.equal(outer.successorPreserved, true);
      const conflict = codedError(error, "SESSION_CACHE_TEMP_RETIRE_GENERATION_CONFLICT") as (Error & {
        committed?: boolean;
        cleanupCommitted?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
      }) | null;
      assert.ok(conflict);
      assert.equal(conflict.committed, true);
      assert.equal(conflict.cleanupCommitted, true);
      assert.equal(conflict.successorPreserved, true);
      assert.ok(conflict.recoveryPaths?.includes(isolatedPath));
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).sessionId, "published-session");
  assert.equal(await readFile(isolatedPath, "utf8"), successor);
  assert.equal(JSON.parse(await readFile(predecessorEvidence, "utf8")).sessionId, "published-session");
});

test("session cache temp retirement preserves a competing canonical successor", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-temp-retire-canonical-root");
  const dataRoot = await tempRoot("cpb-session-cache-temp-retire-canonical-data");
  const directory = path.join(dataRoot, "session-cache");
  const canonicalPath = path.join(directory, "browser-agent.json");
  const publishedEvidence = path.join(directory, ".browser-agent.json.published-evidence");
  let isolatedPath = "";
  const successor = `${JSON.stringify({ marker: "canonical-successor" })}\n`;

  await assert.rejects(
    withSessionCacheTestHooks({
      beforePublishedTempRemoval: async (context) => {
        isolatedPath = context.isolatedPath;
        await rename(canonicalPath, publishedEvidence);
        await writeFile(canonicalPath, successor, { encoding: "utf8", flag: "wx" });
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "published-session", { dataRoot })),
    (error) => {
      const conflict = codedError(error, "SESSION_CACHE_TEMP_RETIRE_GENERATION_CONFLICT") as (Error & {
        committed?: boolean;
        cleanupCommitted?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
      }) | null;
      assert.ok(conflict);
      assert.equal(conflict.committed, true);
      assert.equal(conflict.cleanupCommitted, true);
      assert.equal(conflict.successorPreserved, true);
      assert.ok(conflict.recoveryPaths?.includes(canonicalPath));
      assert.ok(conflict.recoveryPaths?.includes(isolatedPath));
      return true;
    },
  );
  assert.equal(await readFile(canonicalPath, "utf8"), successor);
  assert.equal(JSON.parse(await readFile(isolatedPath, "utf8")).sessionId, "published-session");
  assert.equal(JSON.parse(await readFile(publishedEvidence, "utf8")).sessionId, "published-session");
});

test("session cache reports committed ambiguity when temp isolation fsync fails", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-temp-retire-isolate-root");
  const dataRoot = await tempRoot("cpb-session-cache-temp-retire-isolate-data");
  const canonicalPath = path.join(dataRoot, "session-cache", "browser-agent.json");

  await assert.rejects(
    withSessionCacheTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase === "write-temp-retire") {
          throw Object.assign(new Error("temp isolation directory sync failed"), { code: "EIO" });
        }
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "committed-session", { dataRoot })),
    (error) => {
      const ambiguity = codedError(error, "SESSION_CACHE_TEMP_RETIRE_ISOLATED_AMBIGUOUS") as (Error & {
        committed?: boolean;
        cleanupCommitted?: boolean;
        removalCommitted?: boolean;
        quarantinePreserved?: boolean;
        recoveryPaths?: string[];
      }) | null;
      assert.ok(ambiguity);
      assert.equal(ambiguity.committed, true);
      assert.equal(ambiguity.cleanupCommitted, true);
      assert.equal(ambiguity.removalCommitted, false);
      assert.equal(ambiguity.quarantinePreserved, true);
      assert.ok(ambiguity.recoveryPaths?.includes(canonicalPath));
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).sessionId, "committed-session");
  const entries = await readdir(path.dirname(canonicalPath));
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  const recoveryName = entries.find((entry) => (
    entry.startsWith(".browser-agent.json.write-temp-retire.") && entry.endsWith(".recovery")
  ));
  assert.ok(recoveryName);
  assert.equal(
    JSON.parse(await readFile(path.join(path.dirname(canonicalPath), recoveryName), "utf8")).sessionId,
    "committed-session",
  );
});

test("session cache reports committed ambiguity when temp deletion fsync fails", async () => {
  const cpbRoot = await tempRoot("cpb-session-cache-temp-retire-sync-root");
  const dataRoot = await tempRoot("cpb-session-cache-temp-retire-sync-data");
  const canonicalPath = path.join(dataRoot, "session-cache", "browser-agent.json");

  await assert.rejects(
    withSessionCacheTestHooks({
      syncDirectory: async (_directory, phase) => {
        if (phase === "write-temp-delete") {
          throw Object.assign(new Error("temp deletion directory sync failed"), { code: "EIO" });
        }
      },
    }, () => saveSessionId(cpbRoot, "browser-agent", "committed-session", { dataRoot })),
    (error) => {
      const outer = error as Error & {
        code?: string;
        committed?: boolean;
        cleanupCommitted?: boolean;
        removalCommitted?: boolean;
      };
      assert.equal(outer.code, "SESSION_CACHE_COMMITTED_AMBIGUOUS");
      assert.equal(outer.committed, true);
      assert.equal(outer.cleanupCommitted, true);
      assert.equal(outer.removalCommitted, true);
      const ambiguity = codedError(error, "SESSION_CACHE_TEMP_RETIRE_COMMITTED_AMBIGUOUS") as (Error & {
        committed?: boolean;
        cleanupCommitted?: boolean;
        removalCommitted?: boolean;
        recoveryPaths?: string[];
      }) | null;
      assert.ok(ambiguity);
      assert.equal(ambiguity.committed, true);
      assert.equal(ambiguity.cleanupCommitted, true);
      assert.equal(ambiguity.removalCommitted, true);
      assert.ok(ambiguity.recoveryPaths?.includes(canonicalPath));
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).sessionId, "committed-session");
  assert.equal((await readdir(path.dirname(canonicalPath))).some((entry) => entry.endsWith(".tmp")), false);
});
