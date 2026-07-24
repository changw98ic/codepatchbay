import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  _internalCaptureMigrationPathAuthorityForTests,
  _internalMigrationCommitContextTransplantProbeForTests,
  _internalMigrationCommitOutcomeUnknownProbeForTests,
  _internalParseMigrationJournalForTests,
  _internalPrepareMigrationOutputForTests,
  _internalReadMigrationMetadataForTests,
  _internalRepinMigrationMetadataForTests,
  _internalRetireMigrationPathForTests,
  _internalSignMigrationJournalForTests,
  _internalWithHubRedisMigrationTestHooksForTests,
  _internalWriteMigrationJsonOnceForTests,
  buildLocalRedisMigrationSnapshot,
  hubRedisMigrationJournalPath,
  migrateLocalHubToRedis,
} from "../server/services/hub/hub-redis-migration.js";

function codeOf(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

async function temporaryRoot(t: test.TestContext, name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("Redis migration journal reads reject symbolic links", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-journal-link");
  const target = path.join(root, "journal-target.json");
  const link = path.join(root, "journal.json");
  await writeFile(target, "{}\n", "utf8");
  await symlink(target, link);

  await assert.rejects(
    () => _internalReadMigrationMetadataForTests(link, "journal", 1024),
    (error: unknown) => codeOf(error) === "BOUNDED_FILE_UNSAFE",
  );
});

test("Redis migration snapshot reads reject oversize files and growth after open", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-bounds");
  const oversize = path.join(root, "snapshot.json");
  await writeFile(oversize, JSON.stringify({ payload: "x".repeat(256) }), "utf8");
  await assert.rejects(
    () => _internalReadMigrationMetadataForTests(oversize, "snapshot", 64),
    (error: unknown) => codeOf(error) === "BOUNDED_FILE_TOO_LARGE",
  );

  const growing = path.join(root, "lease.json");
  await writeFile(growing, "{\"leaseId\":\"l-1\"}\n", "utf8");
  await _internalWithHubRedisMigrationTestHooksForTests({
    readHooks: {
      "local-json": {
        afterOpen: async () => {
          await appendFile(growing, " ".repeat(64), "utf8");
        },
      },
    },
  }, async () => {
    await assert.rejects(
      () => _internalReadMigrationMetadataForTests(growing, "local-json", 1024),
      (error: unknown) => codeOf(error) === "BOUNDED_FILE_CHANGED",
    );
  });
});

test("Redis migration metadata authority rejects a same-content path successor", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-metadata-aba");
  const journal = path.join(root, "journal.json");
  const prior = path.join(root, "journal.prior.json");
  const raw = "{\"format\":\"test\"}\n";
  await writeFile(journal, raw, "utf8");
  const pinned = await _internalReadMigrationMetadataForTests(journal, "journal", 1024);
  await rename(journal, prior);
  await writeFile(journal, raw, "utf8");

  await assert.rejects(
    () => _internalRepinMigrationMetadataForTests(pinned.authority, "migration journal"),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED",
  );
});

test("Redis migration journal authentication binds retirement paths and exact authorities", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-journal-auth");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "output");
  const source = path.join(hubRoot, "projects.json");
  const snapshotPath = path.join(output, "redis-logical-snapshot.json");
  await mkdir(hubRoot);
  await mkdir(output);
  await writeFile(source, "{\"version\":1,\"revision\":0,\"projects\":{}}\n", "utf8");
  await writeFile(snapshotPath, "{}\n", "utf8");
  const sourceAuthority = (
    await _internalReadMigrationMetadataForTests(source, "local-json", 16 * 1024 * 1024)
  ).authority;
  const outputAuthority = await _internalCaptureMigrationPathAuthorityForTests(output);
  const outputParentAuthority = await _internalCaptureMigrationPathAuthorityForTests(root);
  const snapshotAuthority = (
    await _internalReadMigrationMetadataForTests(snapshotPath, "snapshot", 300 * 1024 * 1024)
  ).authority;
  const now = new Date().toISOString();
  const unsigned = {
    format: "cpb-hub-redis-migration/v1",
    migrationId: randomUUID(),
    operationToken: randomUUID(),
    phase: "prepared",
    cpbRoot: root,
    hubRoot,
    output,
    outputParentAuthority,
    outputAuthority,
    backupPath: path.join(output, "hub-backup"),
    auditArchivePath: null,
    snapshotPath,
    snapshotSha256: "a".repeat(64),
    snapshotAuthority,
    backendIdentityFingerprint: "b".repeat(64),
    inventory: {
      projects: 0,
      queueEntries: 0,
      assignments: 0,
      attempts: 0,
      workers: 0,
      inboxEntries: 0,
      leases: 0,
      jobs: 0,
      jobEvents: 0,
      runtimeRoots: [],
      sourcePaths: [source],
    },
    localAuthorities: [sourceAuthority],
    createdAt: now,
    updatedAt: now,
  };
  const signingKey = "migration-journal-authentication-key-1234567890";
  const signed = _internalSignMigrationJournalForTests(unsigned, signingKey);
  assert.equal(
    _internalParseMigrationJournalForTests(signed, hubRoot, signingKey).inventory.sourcePaths[0],
    source,
  );

  const tampered = structuredClone(signed);
  tampered.inventory.sourcePaths = [path.join(root, "successor")];
  await assert.rejects(
    async () => _internalParseMigrationJournalForTests(tampered, hubRoot, signingKey),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_AUTHENTICATION_FAILED",
  );

  const outputTampered = structuredClone(signed);
  outputTampered.output = path.join(root, "other-output");
  await assert.rejects(
    async () => _internalParseMigrationJournalForTests(outputTampered, hubRoot, signingKey),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_AUTHENTICATION_FAILED",
  );
});

test("Redis migration commit evidence cannot be transplanted across migration contexts", async () => {
  const { fromA, reboundForB } = await _internalMigrationCommitContextTransplantProbeForTests();
  const source = fromA as {
    committed?: unknown;
    committedPath?: unknown;
    recoveryPaths?: Record<string, unknown>;
  };
  assert.equal(source.committed, true);
  assert.equal(source.committedPath, "/canonical/a/committed");
  assert.equal(source.recoveryPaths?.successor, "/canonical/a/successor");

  const rebound = reboundForB as {
    committed?: unknown;
    committedPath?: unknown;
    redisCommitted?: unknown;
    successorPreserved?: unknown;
    recoveryPaths?: Record<string, unknown>;
  };
  assert.equal(rebound.committed, true);
  assert.equal(rebound.redisCommitted, true);
  assert.equal(rebound.committedPath, null);
  assert.equal(rebound.successorPreserved, undefined);
  assert.deepEqual(rebound.recoveryPaths, {
    output: "/canonical/b/output",
    snapshot: "/canonical/b/snapshot",
    journal: "/canonical/b/journal",
    backup: "/canonical/b/backup",
    result: "/canonical/b/result",
  });
});

test("Redis migration unknown commit outcome keeps only canonical recovery authority", () => {
  const error = _internalMigrationCommitOutcomeUnknownProbeForTests() as Error & {
    code?: unknown;
    commitOutcome?: unknown;
    commitMayHaveOccurred?: unknown;
    committed?: unknown;
    committedPath?: unknown;
    redisCommitted?: unknown;
    successorPreserved?: unknown;
    recoveryPaths?: Record<string, unknown>;
    redisCommitRecovery?: Record<string, unknown>;
  };
  assert.equal(error.code, "HUB_STATE_BACKEND_UNAVAILABLE");
  assert.equal(error.commitOutcome, "unknown");
  assert.equal(error.commitMayHaveOccurred, true);
  assert.equal(error.committed, false);
  assert.equal(error.committedPath, null);
  assert.equal(error.redisCommitted, false);
  assert.equal(error.successorPreserved, undefined);
  assert.deepEqual(error.recoveryPaths, {
    output: "/canonical/unknown/output",
    snapshot: "/canonical/unknown/snapshot",
    journal: "/canonical/unknown/journal",
    backup: "/canonical/unknown/backup",
    result: "/canonical/unknown/result",
  });
  assert.deepEqual(error.redisCommitRecovery, {
    registryKey: "cpb:{unit}:registry",
    stageRegistryKey: "cpb:{unit}:restore:probe:registry",
    stageStreamKeys: [],
    backendIdentityFingerprint: "a".repeat(64),
    snapshotSha256: "b".repeat(64),
  });
});

test("Redis migration fsyncs the output parent before relying on the output directory", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-output-fsync");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "output");
  await mkdir(hubRoot);
  const canonicalOutput = path.join(await realpath(root), "output");
  const syncOperations: string[] = [];

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      syncDirectory: async ({ operation }) => {
        syncOperations.push(operation);
        if (operation === "migration-output-mkdir") throw new Error("injected output-parent fsync failure");
      },
    }, () => _internalPrepareMigrationOutputForTests(output, hubRoot)),
    (error: unknown) => {
      if (codeOf(error) !== "HUB_REDIS_MIGRATION_COMMITTED_DURABILITY_AMBIGUOUS") return false;
      const typed = error as {
        committed?: unknown;
        committedPath?: unknown;
        recoveryPaths?: { output?: unknown };
      };
      return typed.committed === true
        && typed.committedPath === canonicalOutput
        && typed.recoveryPaths?.output === canonicalOutput;
    },
  );
  assert.deepEqual(syncOperations, ["migration-output-mkdir"]);
  assert.equal((await lstat(output)).isDirectory(), true);
});

test("Redis migration rejects an output parent rename-and-successor swap after mkdir", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-output-parent-aba");
  const hubRoot = path.join(root, "hub");
  const parent = path.join(root, "migration-parent");
  const priorParent = path.join(root, "migration-parent.prior");
  const output = path.join(parent, "output");
  await mkdir(hubRoot);
  await mkdir(parent);

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      afterOutputDirectoryMkdir: async () => {
        await rename(parent, priorParent);
        await mkdir(parent);
      },
    }, () => _internalPrepareMigrationOutputForTests(output, hubRoot)),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED",
  );
  assert.equal((await lstat(path.join(priorParent, "output"))).isDirectory(), true);
  assert.equal((await lstat(parent)).isDirectory(), true);
});

test("Redis migration refuses to retire an unbound descendant or symlink", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-tree");
  const hubRoot = path.join(root, "hub");
  const queueRoot = path.join(hubRoot, "queue");
  await mkdir(queueRoot, { recursive: true });
  await writeFile(path.join(queueRoot, "queue.json"), "{\"version\":1,\"entries\":[]}\n", "utf8");
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "{\"preserve\":true}\n", "utf8");
  await symlink(outside, path.join(queueRoot, "unbound-successor.json"));

  await assert.rejects(
    () => buildLocalRedisMigrationSnapshot({
      cpbRoot: root,
      hubRoot,
      backendIdentityFingerprint: "a".repeat(64),
    }),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_UNSAFE",
  );
  assert.equal(await readFile(outside, "utf8"), "{\"preserve\":true}\n");
});

test("Redis migration rejects output with symlinked ancestor inside Hub", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-output-symlink");
  const hubRoot = path.join(root, "hub");
  const outputAlias = path.join(root, "output-parent");
  await mkdir(hubRoot);
  await symlink(hubRoot, outputAlias);

  await assert.rejects(
    () => migrateLocalHubToRedis({
      cpbRoot: root,
      hubRoot,
      configFile: path.join(root, "missing-redis-config.json"),
      output: path.join(outputAlias, "migration-output"),
    }),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_UNSAFE",
  );
});

test("Redis migration retirement isolates but never deletes a successor swapped after repin", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-retire-aba");
  const source = path.join(root, "leases");
  const prior = path.join(root, "leases.prior");
  await mkdir(source);
  await writeFile(path.join(source, "original.json"), "{}\n", "utf8");
  const authority = await _internalCaptureMigrationPathAuthorityForTests(source);
  let isolatedSuccessor = "";

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      beforeAuthorityIsolation: async (context) => {
        isolatedSuccessor = context.quarantinePath;
        await rename(source, prior);
        await mkdir(source);
        await writeFile(path.join(source, "successor.json"), "{}\n", "utf8");
      },
    }, () => _internalRetireMigrationPathForTests(source, authority)),
    (error: unknown) => {
      if (codeOf(error) !== "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED") return false;
      const typed = error as {
        committed?: unknown;
        successorPreserved?: unknown;
        recoveryPaths?: { preservedSuccessor?: unknown };
      };
      return typed.committed === true
        && typed.successorPreserved === true
        && typed.recoveryPaths?.preservedSuccessor === isolatedSuccessor;
    },
  );
  assert.equal((await lstat(source).catch(() => null)), null);
  assert.equal(await readFile(path.join(prior, "original.json"), "utf8"), "{}\n");
  assert.equal(await readFile(path.join(isolatedSuccessor, "successor.json"), "utf8"), "{}\n");
});

test("Redis migration retirement preserves a canonical successor created after isolation", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-retire-successor");
  const source = path.join(root, "events");
  await mkdir(source);
  await writeFile(path.join(source, "original.jsonl"), "{}\n", "utf8");
  const authority = await _internalCaptureMigrationPathAuthorityForTests(source);
  let isolatedAuthority = "";

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      afterAuthorityIsolation: async ({ quarantinePath }) => {
        isolatedAuthority = quarantinePath;
        await mkdir(source);
        await writeFile(path.join(source, "successor.jsonl"), "{\"successor\":true}\n", "utf8");
      },
    }, () => _internalRetireMigrationPathForTests(source, authority)),
    (error: unknown) => {
      if (codeOf(error) !== "HUB_REDIS_MIGRATION_SUCCESSOR_PRESERVED") return false;
      const typed = error as {
        committed?: unknown;
        committedPath?: unknown;
        successorPreserved?: unknown;
        recoveryPaths?: { successor?: unknown };
      };
      return typed.committed === true
        && typed.committedPath === isolatedAuthority
        && typed.successorPreserved === true
        && typed.recoveryPaths?.successor === source;
    },
  );
  assert.equal(await readFile(path.join(source, "successor.jsonl"), "utf8"), "{\"successor\":true}\n");
  assert.equal(await readFile(path.join(isolatedAuthority, "original.jsonl"), "utf8"), "{}\n");
});

test("Redis migration retirement preserves an isolated-path successor created before removal", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-isolated-successor");
  const source = path.join(root, "queue");
  await mkdir(source);
  await writeFile(path.join(source, "queue.json"), "{\"version\":1,\"entries\":[]}\n", "utf8");
  const authority = await _internalCaptureMigrationPathAuthorityForTests(source);
  let isolatedSuccessor = "";

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      afterAuthorityIsolation: async ({ quarantinePath }) => {
        isolatedSuccessor = quarantinePath;
        await rename(quarantinePath, `${quarantinePath}.prior`);
        await mkdir(quarantinePath);
        await writeFile(path.join(quarantinePath, "successor.json"), "{\"successor\":true}\n", "utf8");
      },
    }, () => _internalRetireMigrationPathForTests(source, authority)),
    (error: unknown) => {
      if (codeOf(error) !== "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED") return false;
      const typed = error as {
        committed?: unknown;
        successorPreserved?: unknown;
        recoveryPaths?: { preservedSuccessor?: unknown };
      };
      return typed.committed === true
        && typed.successorPreserved === true
        && typed.recoveryPaths?.preservedSuccessor === isolatedSuccessor;
    },
  );
  assert.equal(await readFile(path.join(isolatedSuccessor, "successor.json"), "utf8"), "{\"successor\":true}\n");
  assert.equal(
    await readFile(path.join(`${isolatedSuccessor}.prior`, "queue.json"), "utf8"),
    "{\"version\":1,\"entries\":[]}\n",
  );
});

test("Redis migration retirement reports committed rename durability ambiguity with recovery paths", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-retire-fsync");
  const source = path.join(root, "assignments");
  await mkdir(source);
  await writeFile(path.join(source, "state.json"), "{}\n", "utf8");
  const authority = await _internalCaptureMigrationPathAuthorityForTests(source);

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      syncDirectory: async ({ operation }) => {
        if (operation === "retirement-isolate") throw new Error("injected parent fsync failure");
      },
    }, () => _internalRetireMigrationPathForTests(source, authority)),
    (error: unknown) => {
      if (codeOf(error) !== "HUB_REDIS_MIGRATION_COMMITTED_DURABILITY_AMBIGUOUS") return false;
      const typed = error as {
        committed?: unknown;
        committedPath?: unknown;
        recoveryPaths?: { isolatedAuthority?: unknown; canonical?: unknown };
      };
      return typed.committed === true
        && typed.committedPath === typed.recoveryPaths?.isolatedAuthority
        && typed.recoveryPaths?.canonical === source;
    },
  );
});

test("Redis migration retirement reports truthful metadata after preservation fsync failure", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-delete-fsync");
  const source = path.join(root, "workers");
  await mkdir(source);
  await writeFile(path.join(source, "worker.json"), "{}\n", "utf8");
  const authority = await _internalCaptureMigrationPathAuthorityForTests(source);

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      syncDirectory: async ({ operation }) => {
        if (operation === "retirement-preserve") throw new Error("injected isolation fsync failure");
      },
    }, () => _internalRetireMigrationPathForTests(source, authority)),
    (error: unknown) => {
      if (codeOf(error) !== "HUB_REDIS_MIGRATION_COMMITTED_DURABILITY_AMBIGUOUS") return false;
      const typed = error as {
        committed?: unknown;
        committedPath?: unknown;
        recoveryPaths?: { deletedCanonical?: unknown; isolatedAuthority?: unknown; preservedAuthority?: unknown };
      };
      return typed.committed === true
        && typed.committedPath === typed.recoveryPaths?.isolatedAuthority
        && typed.recoveryPaths?.deletedCanonical === source
        && typed.recoveryPaths?.preservedAuthority === typed.recoveryPaths?.isolatedAuthority;
    },
  );
  assert.equal(await lstat(source).catch(() => null), null);
});

test("Redis migration retirement preserves isolated authority evidence on success", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-preserve-evidence");
  const source = path.join(root, "events");
  await mkdir(source);
  await writeFile(path.join(source, "job.jsonl"), "{}\n", "utf8");
  const authority = await _internalCaptureMigrationPathAuthorityForTests(source);

  assert.equal(await _internalRetireMigrationPathForTests(source, authority), true);
  assert.equal(await lstat(source).catch(() => null), null);
  const isolationRoot = (await readdir(root)).find((entry) => entry.includes(".events.cpb-redis-migration-"));
  assert.ok(isolationRoot);
  assert.equal(await readFile(path.join(root, isolationRoot, "authority", "job.jsonl"), "utf8"), "{}\n");
});

test("Redis migration no-clobber publication preserves temporary evidence link", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-publish-evidence");
  const artifact = path.join(root, "migration-result.json");

  await _internalWriteMigrationJsonOnceForTests(artifact, { ok: true }, "migration-result");

  assert.equal(await readFile(artifact, "utf8"), "{\n  \"ok\": true\n}\n");
  const tempEvidence = (await readdir(root)).filter((entry) => (
    entry.startsWith(".migration-result.json.") && entry.endsWith(".tmp")
  ));
  assert.equal(tempEvidence.length, 1);
  assert.equal(await readFile(path.join(root, tempEvidence[0]), "utf8"), "{\n  \"ok\": true\n}\n");
});

test("Redis migration result publication rejects an output rename-and-successor ABA and preserves recovery", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-result-output-aba");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "output");
  const priorOutput = path.join(root, "output.prior");
  const journal = hubRedisMigrationJournalPath(hubRoot);
  const result = path.join(output, "migration-result.json");
  await mkdir(hubRoot);
  await writeFile(journal, "{\"phase\":\"redis_committed\"}\n", "utf8");
  const lineage = await _internalPrepareMigrationOutputForTests(output, hubRoot);

  await assert.rejects(
    () => _internalWithHubRedisMigrationTestHooksForTests({
      afterMigrationArtifactPublish: async ({ operation }) => {
        if (operation !== "migration-result") return;
        await rename(output, priorOutput);
        await mkdir(output);
      },
    }, () => _internalWriteMigrationJsonOnceForTests(
      result,
      { ok: true },
      "migration-result",
      lineage,
    )),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED",
  );

  assert.equal(await lstat(result).catch(() => null), null);
  assert.equal(await readFile(path.join(priorOutput, "migration-result.json"), "utf8"), "{\n  \"ok\": true\n}\n");
  assert.equal(await readFile(journal, "utf8"), "{\"phase\":\"redis_committed\"}\n");
  assert.equal((await lstat(output)).isDirectory(), true);
});

test("Redis migration test hooks are scoped to async-local execution", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-als-hooks");
  const localJson = path.join(root, "local.json");
  const journal = path.join(root, "journal.json");
  await writeFile(localJson, "{}\n", "utf8");
  await writeFile(journal, "{}\n", "utf8");

  const scoped = _internalWithHubRedisMigrationTestHooksForTests({
    readHooks: {
      "local-json": {
        afterOpen: async () => {
          await appendFile(localJson, " ".repeat(64), "utf8");
        },
      },
    },
  }, async () => assert.rejects(
    () => _internalReadMigrationMetadataForTests(localJson, "local-json", 1024),
    (error: unknown) => codeOf(error) === "BOUNDED_FILE_CHANGED",
  ));
  const unscoped = _internalReadMigrationMetadataForTests(journal, "journal", 1024);

  await scoped;
  assert.deepEqual((await unscoped).value, {});
});

test("Redis migration test hook scopes remain isolated under concurrency", async (t) => {
  const root = await temporaryRoot(t, "cpb-redis-migration-als-concurrent");
  const left = path.join(root, "left.json");
  const right = path.join(root, "right.json");
  await writeFile(left, "{}\n", "utf8");
  await writeFile(right, "{}\n", "utf8");

  const leftRun = _internalWithHubRedisMigrationTestHooksForTests({
    readHooks: {
      "local-json": {
        afterOpen: async () => {
          await appendFile(left, " ".repeat(64), "utf8");
        },
      },
    },
  }, async () => assert.rejects(
    () => _internalReadMigrationMetadataForTests(left, "local-json", 1024),
    (error: unknown) => codeOf(error) === "BOUNDED_FILE_CHANGED",
  ));

  const rightRun = _internalWithHubRedisMigrationTestHooksForTests({}, async () => {
    assert.deepEqual((await _internalReadMigrationMetadataForTests(right, "local-json", 1024)).value, {});
  });

  await Promise.all([leftRun, rightRun]);
});
