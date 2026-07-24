import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  _internalHubMaintenanceFenceForTests,
  acquireHubMaintenance,
  assertHubWritable,
  fsyncDirectory,
  hubMaintenanceLockPath,
  hubRestoreJournalPath,
  readHubMaintenance,
  removeDurable,
  writeJsonDurableAtomic,
} from "../shared/hub-maintenance.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import { startHubServer } from "../server/index.js";
import { HubOrchestrator } from "../server/orchestrator/hub-orchestrator.js";
import { WorkerSupervisor } from "../server/orchestrator/worker-supervisor.js";
import { createHubBackup } from "../server/services/hub/hub-backup.js";
import { enqueue } from "../server/services/hub/hub-queue.js";
import { getHubRuntime, saveRegistry } from "../server/services/hub/hub-registry.js";
import { appendCommand } from "../server/services/quota-delegate-client.js";
import { captureCurrentProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listenOnLoopback(
  port: number,
  handler: (socket: net.Socket) => void,
) {
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    handler(socket);
  });
  server.unref();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  return server;
}

async function closeServer(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("Hub maintenance lease fences writes and releases only its own token", async () => {
  const root = await tempRoot("cpb-hub-maintenance-lease");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });

  const lease = await acquireHubMaintenance(hubRoot, "backup");
  await assert.rejects(assertHubWritable(hubRoot), /backup is active/);
  await assert.rejects(acquireHubMaintenance(hubRoot, "restore"), /already held/);
  assert.equal((await readHubMaintenance(hubRoot)).active, true);

  assert.equal(await lease.release(), true);
  await assert.doesNotReject(assertHubWritable(hubRoot));
  assert.equal((await readHubMaintenance(hubRoot)).active, false);
});

test("maintenance acquisition preserves committed owner evidence when lock parent sync is ambiguous", async () => {
  const root = await tempRoot("cpb-hub-maintenance-parent-sync-ambiguity");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const ownerPath = path.join(lockPath, "owner.json");

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "backup", {
      hooks: {
        beforeLockParentSync() {
          throw new Error("simulated Hub maintenance parent sync failure");
        },
      },
    }),
    (error: unknown) => {
      const ambiguity = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: { lockPath: string; ownerPath: string };
      };
      assert.equal(ambiguity.code, "HUB_MAINTENANCE_ACQUIRE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(ambiguity.committed, true);
      assert.equal(ambiguity.committedPath, ownerPath);
      assert.deepEqual(ambiguity.recoveryPaths, { lockPath, ownerPath });
      assert.match(String(ambiguity.cause), /simulated Hub maintenance parent sync failure/);
      return true;
    },
  );

  const persisted = JSON.parse(await readFile(ownerPath, "utf8")) as { operation?: string; ownerToken?: string };
  assert.equal(persisted.operation, "backup");
  assert.equal(typeof persisted.ownerToken, "string");
  assert.ok(persisted.ownerToken);
  assert.equal((await readHubMaintenance(hubRoot)).active, true);
});

test("writeJsonDurableAtomic reports committed durability ambiguity after rename fsync failure", async () => {
  const root = await tempRoot("cpb-hub-maintenance-durable-json");
  const filePath = path.join(root, "state", "owner.json");
  const injected = Object.assign(new Error("injected parent fsync failure after rename"), { code: "EIO" });
  let observedParent = "";
  let failure: unknown;

  try {
    await writeJsonDurableAtomic(filePath, { ownerToken: "committed-owner" }, {
      syncParentDirectory: async (directory) => {
        observedParent = directory;
        throw injected;
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.equal((failure as { code?: unknown }).code, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal((failure as { committed?: unknown }).committed, true);
  assert.equal((failure as { committedPath?: unknown }).committedPath, filePath);
  assert.equal((failure as { filePath?: unknown }).filePath, filePath);
  assert.equal((failure as { cause?: unknown }).cause, injected);
  assert.equal((failure as { primaryError?: unknown }).primaryError, injected);
  assert.deepEqual((failure as { cleanupErrors?: unknown[] }).cleanupErrors, []);
  assert.equal((failure as AggregateError).errors[0], injected);
  assert.equal(observedParent, path.dirname(filePath));
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { ownerToken: "committed-owner" });
});

test("writeJsonDurableAtomic preserves a post-rename pathname successor", async () => {
  const root = await tempRoot("cpb-hub-maintenance-durable-json-publish-aba");
  const filePath = path.join(root, "state", "owner.json");
  const displacedPath = path.join(root, "published-original.json");

  await assert.rejects(
    writeJsonDurableAtomic(filePath, { ownerToken: "published-owner" }, {
      async afterPublishRename() {
        await rename(filePath, displacedPath);
        await writeFile(filePath, `${JSON.stringify({ ownerToken: "successor-owner" })}\n`, "utf8");
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      committedPath?: string;
      successorPreserved?: boolean;
      recoveryPaths?: { filePath: string; parent: string };
    }) => {
      assert.equal(error.code, "DURABLE_JSON_COMMITTED_PUBLICATION_RACE");
      assert.equal(error.committed, true);
      assert.equal(error.committedPath, filePath);
      assert.equal(error.successorPreserved, true);
      assert.deepEqual(error.recoveryPaths, { filePath, parent: path.dirname(filePath) });
      return true;
    },
  );

  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { ownerToken: "successor-owner" });
  assert.deepEqual(JSON.parse(await readFile(displacedPath, "utf8")), { ownerToken: "published-owner" });
});

test("writeJsonDurableAtomic preserves a pathname successor during failed-temp isolation", async () => {
  const root = await tempRoot("cpb-hub-maintenance-durable-json-temp-aba");
  const filePath = path.join(root, "state", "owner.json");
  const displacedPath = path.join(root, "displaced-original.tmp");
  const injected = Object.assign(new Error("injected pre-publication failure"), { code: "EIO" });
  let tempPath = "";

  await assert.rejects(
    writeJsonDurableAtomic(filePath, { ownerToken: "unpublished-owner" }, {
      beforePublishRename() {
        throw injected;
      },
      async beforeTempIsolation(context) {
        tempPath = context.tempPath;
        await rename(context.tempPath, displacedPath);
        await writeFile(context.tempPath, "successor\n", "utf8");
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      successorPreserved?: boolean;
      primaryError?: unknown;
      recoveryPaths?: { filePath: string; tempPath: string };
    }) => {
      assert.equal(error.code, "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED");
      assert.equal(error.committed, false);
      assert.equal(error.successorPreserved, true);
      assert.equal(error.primaryError, injected);
      assert.deepEqual(error.recoveryPaths, { filePath, tempPath });
      return true;
    },
  );

  await assert.rejects(access(filePath), { code: "ENOENT" });
  assert.equal(await readFile(tempPath, "utf8"), "successor\n");
  assert.deepEqual(JSON.parse(await readFile(displacedPath, "utf8")), { ownerToken: "unpublished-owner" });
});

test("writeJsonDurableAtomic isolates its own failed temp and reports recovery authority", async () => {
  const root = await tempRoot("cpb-hub-maintenance-durable-json-temp-isolation");
  const filePath = path.join(root, "state", "owner.json");
  const injected = Object.assign(new Error("stop before publication"), { code: "EIO" });
  let tempPath = "";

  await assert.rejects(
    writeJsonDurableAtomic(filePath, { ownerToken: "isolated-owner" }, {
      beforePublishRename(context) {
        tempPath = context.tempPath;
        throw injected;
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      cleanupCommitted?: boolean;
      quarantinePreserved?: boolean;
      recoveryPaths?: { filePath: string; tempPath: string; quarantinePath?: string };
      cause?: unknown;
    }) => {
      assert.equal(error.code, "EIO");
      assert.equal(error.committed, false);
      assert.equal(error.cleanupCommitted, true);
      assert.equal(error.quarantinePreserved, true);
      assert.equal(error.cause, injected);
      assert.equal(error.recoveryPaths?.filePath, filePath);
      assert.equal(error.recoveryPaths?.tempPath, tempPath);
      assert.ok(error.recoveryPaths?.quarantinePath?.startsWith(`${tempPath}.failed-`));
      return true;
    },
  );

  await assert.rejects(access(filePath), { code: "ENOENT" });
  await assert.rejects(access(tempPath), { code: "ENOENT" });
  const residuals = (await readdir(path.dirname(filePath)))
    .filter((entry) => entry.startsWith(`${path.basename(tempPath)}.failed-`));
  assert.equal(residuals.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(path.dirname(filePath), residuals[0]), "utf8")), {
    ownerToken: "isolated-owner",
  });
});

test("writeJsonDurableAtomic rejects a symbolic-link parent before publication", async () => {
  const root = await tempRoot("cpb-hub-maintenance-durable-json-parent-symlink");
  const authority = path.join(root, "authority");
  const alias = path.join(root, "authority-alias");
  await mkdir(authority);
  await symlink(authority, alias, "dir");

  await assert.rejects(
    writeJsonDurableAtomic(path.join(alias, "state.json"), { unsafe: true }),
    { code: "DURABLE_JSON_PARENT_UNSAFE" },
  );
  await assert.rejects(access(path.join(authority, "state.json")), { code: "ENOENT" });
});

test("fsyncDirectory does not treat unsupported durability as success", async () => {
  const root = await tempRoot("cpb-hub-maintenance-fsync-unsupported");
  const unsupported = Object.assign(new Error("directory fsync unsupported"), { code: "ENOTSUP" });
  let closed = false;
  await assert.rejects(
    fsyncDirectory(root, {
      openDirectory: async (directory, flags) => {
        const handle = await openFile(directory, flags);
        return {
          stat: () => handle.stat(),
          sync: async () => { throw unsupported; },
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    }),
    (error: unknown) => error === unsupported,
  );
  assert.equal(closed, true);
});

test("fsyncDirectory opens and validates the directory with no-follow directory flags", async () => {
  const root = await tempRoot("cpb-hub-maintenance-fsync-flags");
  let observedFlags: number | undefined;

  await fsyncDirectory(root, {
    openDirectory: async (directory, flags) => {
      observedFlags = flags;
      return openFile(directory, flags);
    },
  });

  assert.equal(typeof observedFlags, "number");
  assert.equal((observedFlags! & constants.O_NOFOLLOW) === constants.O_NOFOLLOW, true);
  assert.equal((observedFlags! & constants.O_DIRECTORY) === constants.O_DIRECTORY, true);
});

test("fsyncDirectory rejects a symbolic-link directory authority", async () => {
  const root = await tempRoot("cpb-hub-maintenance-fsync-symlink");
  const authority = path.join(root, "authority");
  const alias = path.join(root, "authority-alias");
  await mkdir(authority);
  await symlink(authority, alias, "dir");

  await assert.rejects(
    fsyncDirectory(alias),
    { code: "DIRECTORY_AUTHORITY_UNSAFE" },
  );
});

test("removeDurable reports committed ambiguity when parent fsync fails", async () => {
  const root = await tempRoot("cpb-hub-maintenance-remove-durable");
  const filePath = path.join(root, "state.json");
  await writeFile(filePath, "state\n", "utf8");
  const fsyncFailure = Object.assign(new Error("remove parent fsync failed"), { code: "EIO" });

  await assert.rejects(
    removeDurable(filePath, {
      syncParentDirectory: async () => { throw fsyncFailure; },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      committedPath?: string;
      recoveryPaths?: { quarantine?: string; parent?: string };
      attemptedPaths?: { canonical?: string };
      cause?: unknown;
    }) => {
      assert.equal(error.code, "DURABLE_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.ok(error.committedPath?.startsWith(path.join(root, ".removed-")));
      assert.equal(error.recoveryPaths?.quarantine, error.committedPath);
      assert.equal(error.recoveryPaths?.parent, root);
      assert.equal(error.attemptedPaths?.canonical, filePath);
      assert.equal(error.cause, fsyncFailure);
      return true;
    },
  );
  await assert.rejects(access(filePath), { code: "ENOENT" });
});

test("removeDurable preserves a replacement observed before isolation", async () => {
  const root = await tempRoot("cpb-hub-maintenance-remove-race");
  const filePath = path.join(root, "state.json");
  const displaced = path.join(root, "state.original.json");
  await writeFile(filePath, "original\n", "utf8");

  await assert.rejects(
    removeDurable(filePath, {
      async beforeRename() {
        await rename(filePath, displaced);
        await writeFile(filePath, "successor\n", "utf8");
      },
    }),
    { code: "DURABLE_REMOVE_RACE" },
  );
  assert.equal(await readFile(filePath, "utf8"), "successor\n");
  assert.equal(await readFile(displaced, "utf8"), "original\n");
});

test("removeDurable preserves a successor installed as the final isolation callback returns", async () => {
  for (const variant of ["regular", "symlink"] as const) {
    const root = await tempRoot(`cpb-hub-maintenance-remove-final-race-${variant}`);
    const filePath = path.join(root, "state.json");
    const displaced = path.join(root, "state.original.json");
    const external = path.join(root, "external.json");
    let quarantinePath = "";
    await writeFile(filePath, "original\n", "utf8");
    await writeFile(external, "external\n", "utf8");

    await assert.rejects(
      removeDurable(filePath, {
        async beforeFinalRename(context) {
          quarantinePath = context.quarantinePath;
          await rename(filePath, displaced);
          if (variant === "regular") await writeFile(filePath, "successor\n", "utf8");
          else await symlink(external, filePath);
        },
      }),
      { code: "DURABLE_REMOVE_RACE" },
    );

    assert.equal(await readFile(displaced, "utf8"), "original\n");
    if (variant === "regular") assert.equal(await readFile(filePath, "utf8"), "successor\n");
    else assert.equal((await lstat(filePath)).isSymbolicLink(), true);
    await assert.rejects(access(quarantinePath), { code: "ENOENT" });
  }
});

test("removeDurable never replaces a hostile quarantine target", async () => {
  const root = await tempRoot("cpb-hub-maintenance-remove-quarantine-conflict");
  const filePath = path.join(root, "state.json");
  let quarantinePath = "";
  await writeFile(filePath, "original\n", "utf8");

  await assert.rejects(
    removeDurable(filePath, {
      async beforeRename(context) {
        quarantinePath = context.quarantinePath;
        await writeFile(quarantinePath, "hostile-successor\n", "utf8");
      },
    }),
    (error: Error & { code?: string; committed?: boolean; successorPreserved?: boolean }) => {
      assert.equal(error.code, "DURABLE_REMOVE_QUARANTINE_CONFLICT");
      assert.equal(error.committed, false);
      assert.equal(error.successorPreserved, true);
      return true;
    },
  );
  assert.equal(await readFile(filePath, "utf8"), "original\n");
  assert.equal(await readFile(quarantinePath, "utf8"), "hostile-successor\n");
});

test("removeDurable never reports a replaced quarantine as recovery evidence", async () => {
  const root = await tempRoot("cpb-hub-maintenance-remove-quarantine-replaced");
  const filePath = path.join(root, "state.json");
  const predecessorPath = path.join(root, "verified-predecessor.json");
  let quarantinePath = "";
  await writeFile(filePath, "predecessor\n", "utf8");

  await assert.rejects(
    removeDurable(filePath, {
      afterRename: async ({ quarantinePath: observed }) => {
        quarantinePath = observed;
        await rename(observed, predecessorPath);
        await writeFile(observed, "hostile-successor\n", "utf8");
      },
    }),
    (error: Error & {
      committed?: boolean;
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      recoveryPaths?: Record<string, string>;
      attemptedPaths?: Record<string, string>;
      predecessorGeneration?: unknown;
    }) => {
      assert.equal(error.committed, true);
      assert.equal(error.quarantinePreserved, undefined);
      assert.equal(error.successorPreserved, true);
      assert.equal(error.recoveryPaths?.quarantine, undefined);
      assert.equal(error.attemptedPaths?.quarantine, quarantinePath);
      assert.ok(error.predecessorGeneration);
      return true;
    },
  );
  assert.equal(await readFile(predecessorPath, "utf8"), "predecessor\n");
  assert.equal(await readFile(quarantinePath, "utf8"), "hostile-successor\n");
});

test("removeDurable rejects a symbolic-link parent authority before isolation", async () => {
  const root = await tempRoot("cpb-hub-maintenance-remove-parent-symlink");
  const authority = path.join(root, "authority");
  const alias = path.join(root, "authority-alias");
  await mkdir(authority);
  await writeFile(path.join(authority, "state.json"), "preserve\n", "utf8");
  await symlink(authority, alias, "dir");

  await assert.rejects(
    removeDurable(path.join(alias, "state.json")),
    { code: "DURABLE_REMOVE_PARENT_UNSAFE" },
  );
  assert.equal(await readFile(path.join(authority, "state.json"), "utf8"), "preserve\n");
});

test("old maintenance owner cannot release a replacement lease", async () => {
  const root = await tempRoot("cpb-hub-maintenance-replacement");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const first = await acquireHubMaintenance(hubRoot, "backup");
  const displaced = `${first.lockPath}.displaced`;
  await rename(first.lockPath, displaced);
  const replacement = await acquireHubMaintenance(hubRoot, "restore");

  assert.equal(await first.release(), false);
  assert.equal((await readHubMaintenance(hubRoot)).owner?.ownerToken, replacement.owner.ownerToken);

  assert.equal(await replacement.release(), true);
  await rm(displaced, { recursive: true, force: true });
});

test("maintenance release preserves a copied whole-owner replacement generation", async () => {
  const root = await tempRoot("cpb-hub-maintenance-release-same-owner-aba");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const lease = await acquireHubMaintenance(hubRoot, "backup");
  const displaced = `${lease.lockPath}.displaced`;
  await rename(lease.lockPath, displaced);
  await mkdir(lease.lockPath);
  await writeFile(path.join(lease.lockPath, "owner.json"), `${JSON.stringify(lease.owner, null, 2)}\n`, "utf8");
  await writeFile(path.join(lease.lockPath, "successor-marker"), "preserve\n", "utf8");

  assert.equal(await lease.release(), false);
  assert.equal(await readFile(path.join(lease.lockPath, "successor-marker"), "utf8"), "preserve\n");

  await rm(displaced, { recursive: true, force: true });
  await rm(lease.lockPath, { recursive: true, force: true });
});

test("maintenance acquisition preserves a legacy owner without exact identity after ESRCH", async () => {
  const root = await tempRoot("cpb-hub-maintenance-stale");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "dead-owner",
    operation: "backup",
    hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");

  await assert.rejects(acquireHubMaintenance(hubRoot, "restore"), /already held/);
  assert.equal((await readHubMaintenance(hubRoot)).owner?.ownerToken, "dead-owner");
  await access(path.join(lockPath, "owner.json"));
});

test("maintenance v2 owner with coarse process identity fails closed", async () => {
  const root = await tempRoot("cpb-hub-maintenance-coarse-owner");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "coarse-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: current.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      ...current,
      birthIdPrecision: "coarse",
    },
  })}\n`, "utf8");

  await assert.rejects(acquireHubMaintenance(hubRoot, "restore"), /valid process identity|owner is invalid/);
  await access(lockPath);
});

test("maintenance v2 owner missing explicit exact precision fails closed", async () => {
  const root = await tempRoot("cpb-hub-maintenance-missing-precision-owner");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const { birthIdPrecision: _missing, ...identityWithoutPrecision } = {
    ...current,
    birthIdPrecision: undefined,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "missing-precision-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: current.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: identityWithoutPrecision,
  })}\n`, "utf8");

  await assert.rejects(acquireHubMaintenance(hubRoot, "restore"), /valid process identity|owner is invalid/);
  await access(lockPath);
});

test("maintenance acquisition rejects missing or coarse capture precision without publishing", async () => {
  const root = await tempRoot("cpb-hub-maintenance-capture-precision");
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const missingPrecision = { ...current };
  delete (missingPrecision as Partial<typeof current>).birthIdPrecision;

  for (const [variant, identity] of [
    ["missing", missingPrecision],
    ["coarse", { ...current, birthIdPrecision: "coarse" as const }],
  ] as const) {
    const hubRoot = path.join(root, variant);
    const lockPath = hubMaintenanceLockPath(hubRoot);
    await assert.rejects(
      acquireHubMaintenance(hubRoot, "backup", {
        hooks: { captureProcessIdentity: () => identity as typeof current },
      }),
      { code: "HUB_MAINTENANCE_IDENTITY_UNAVAILABLE" },
    );
    await assert.rejects(access(lockPath), { code: "ENOENT" });
  }
});

test("maintenance identity observation errors fail explicitly without reclaiming", async () => {
  const root = await tempRoot("cpb-hub-maintenance-identity-observation-error");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const owner = {
    format: "cpb-hub-maintenance/v2",
    ownerToken: "identity-observation-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: current.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: current,
  } as const;
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
  const injected = Object.assign(new Error("identity observation unavailable"), {
    code: "PROCESS_IDENTITY_UNAVAILABLE",
  });

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        isProcessIdentityAlive() {
          throw injected;
        },
      },
    }),
    (error: Error & { code?: string; cause?: unknown }) => {
      assert.equal(error.code, "HUB_MAINTENANCE_IDENTITY_CHECK_FAILED");
      assert.equal(error.cause, injected);
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
});

test("maintenance v2 owner with noncanonical acquisition timestamp fails closed", async () => {
  const root = await tempRoot("cpb-hub-maintenance-noncanonical-owner-time");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "noncanonical-time-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: current.pid,
    host: os.hostname(),
    acquiredAt: "2026-01-01T00:00:00Z",
    processIdentity: current,
  })}\n`, "utf8");

  await assert.rejects(acquireHubMaintenance(hubRoot, "restore"), /owner is invalid/);
  await access(lockPath);
});

test("maintenance process fence skips an unrelated first candidate port", async () => {
  const root = await tempRoot("cpb-hub-maintenance-unrelated-fence");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const fence = _internalHubMaintenanceFenceForTests(hubRoot);
  const unrelated = await listenOnLoopback(fence.ports[0], (socket) => {
    socket.end("unrelated-listener\n");
  });
  try {
    const lease = await acquireHubMaintenance(hubRoot, "backup");
    assert.equal((await readHubMaintenance(hubRoot)).owner?.ownerToken, lease.owner.ownerToken);
    assert.equal(await lease.release(), true);
  } finally {
    await closeServer(unrelated);
  }
});

test("maintenance process fence rejects an existing same-key owner", async () => {
  const root = await tempRoot("cpb-hub-maintenance-same-key-fence");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const fence = _internalHubMaintenanceFenceForTests(hubRoot);
  const owner = await listenOnLoopback(fence.ports[0], (socket) => {
    socket.end(`${fence.protocol}${fence.key}\n`);
  });
  try {
    await assert.rejects(acquireHubMaintenance(hubRoot, "backup"), { code: "HUB_MAINTENANCE_FENCE_BUSY" });
  } finally {
    await closeServer(owner);
  }
});

test("maintenance process fence fails closed on an unresponsive listener", async () => {
  const root = await tempRoot("cpb-hub-maintenance-unresponsive-fence");
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const fence = _internalHubMaintenanceFenceForTests(hubRoot);
  const sockets = new Set<net.Socket>();
  const owner = await listenOnLoopback(fence.ports[0], (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await assert.rejects(acquireHubMaintenance(hubRoot, "backup"), { code: "HUB_MAINTENANCE_FENCE_BUSY" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeServer(owner);
  }
});

test("maintenance stale recovery serializes three contenders and preserves the winner", async () => {
  const root = await tempRoot("cpb-hub-maintenance-three-party-aba");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-maintenance-owner`,
    incarnation: `${current.pid}:${current.birthId}:stale-maintenance-owner`,
    birthIdPrecision: "exact" as const,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "stale-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  })}\n`, "utf8");

  const observed = deferred();
  const continueRecovery = deferred();
  const first = acquireHubMaintenance(hubRoot, "restore-a", {
    hooks: {
      afterRecoveryStateObserved: async () => {
        observed.resolve();
        await continueRecovery.promise;
      },
    },
  });
  await observed.promise;
  const second = acquireHubMaintenance(hubRoot, "restore-b");
  const third = acquireHubMaintenance(hubRoot, "restore-c");
  continueRecovery.resolve();

  const results = await Promise.allSettled([first, second, third]);
  const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<typeof first>> => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal((await readHubMaintenance(hubRoot)).owner?.ownerToken, winners[0].value.owner.ownerToken);
  assert.equal(await winners[0].value.release(), true);
});

test("maintenance restore preserves an empty successor and quarantine evidence", async () => {
  const root = await tempRoot("cpb-hub-maintenance-empty-successor");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-empty-successor`,
    incarnation: `${current.pid}:${current.birthId}:stale-empty-successor`,
    birthIdPrecision: "exact" as const,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "stale-empty-successor-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  })}\n`, "utf8");

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        async afterQuarantineRename() {
          await mkdir(lockPath);
          throw new Error("force restore after empty successor mkdir");
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.errors.some((entry) => (entry as NodeJS.ErrnoException).code === "HUB_MAINTENANCE_SUCCESSOR_PRESERVED"),
        true,
      );
      return true;
    },
  );
  assert.deepEqual(await readdir(lockPath), []);
  const residuals = (await readdir(path.dirname(lockPath)))
    .filter((entry) => entry.startsWith(`${path.basename(lockPath)}.stale-`));
  assert.equal(residuals.length, 1);
});

test("maintenance quarantine hook failure preserves evidence without path reconstruction", async () => {
  const root = await tempRoot("cpb-hub-maintenance-quarantine-failclosed");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-quarantine-failclosed`,
    incarnation: `${current.pid}:${current.birthId}:stale-quarantine-failclosed`,
    birthIdPrecision: "exact" as const,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "stale-quarantine-failclosed-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  })}\n`, "utf8");

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        afterQuarantineRename() {
          throw new Error("injected quarantine hook failure");
        },
      },
    }),
    { code: "HUB_MAINTENANCE_QUARANTINE_PRESERVED" },
  );

  await assert.rejects(access(lockPath), { code: "ENOENT" });
  const residuals = (await readdir(path.dirname(lockPath)))
    .filter((entry) => entry.startsWith(`${path.basename(lockPath)}.stale-`));
  assert.equal(residuals.length, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(path.dirname(lockPath), residuals[0], "owner.json"), "utf8")).ownerToken,
    "stale-quarantine-failclosed-owner",
  );
});

test("maintenance quarantine never removes a same-owner replacement generation", async () => {
  const root = await tempRoot("cpb-hub-maintenance-quarantine-same-owner-aba");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-same-owner-aba`,
    incarnation: `${current.pid}:${current.birthId}:stale-same-owner-aba`,
    birthIdPrecision: "exact" as const,
  };
  const owner = {
    format: "cpb-hub-maintenance/v2",
    ownerToken: "same-owner-generation-token",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
  let replacementPath = "";

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        async afterQuarantineRename({ quarantinePath }) {
          replacementPath = quarantinePath;
          await rm(quarantinePath, { recursive: true });
          await mkdir(quarantinePath);
          await writeFile(path.join(quarantinePath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
          await writeFile(path.join(quarantinePath, "successor-marker"), "preserve\n", "utf8");
        },
      },
    }),
    { code: "HUB_MAINTENANCE_QUARANTINE_PRESERVED" },
  );

  assert.equal(await readFile(path.join(replacementPath, "successor-marker"), "utf8"), "preserve\n");
  assert.equal(JSON.parse(await readFile(path.join(replacementPath, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
});

test("maintenance quarantine preserves a same-owner in-place directory generation change", async () => {
  const root = await tempRoot("cpb-hub-maintenance-quarantine-in-place-aba");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-in-place-aba`,
    incarnation: `${current.pid}:${current.birthId}:stale-in-place-aba`,
    birthIdPrecision: "exact" as const,
  };
  const owner = {
    format: "cpb-hub-maintenance/v2",
    ownerToken: "same-owner-in-place-token",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
  let quarantinePath = "";

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        async afterQuarantineRename(context) {
          quarantinePath = context.quarantinePath;
          await writeFile(path.join(quarantinePath, "same-token-successor"), "preserve\n", "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException & { quarantinePreserved?: boolean }) => error.code === "HUB_MAINTENANCE_QUARANTINE_PRESERVED"
      && error.quarantinePreserved === true,
  );

  assert.equal(await readFile(path.join(quarantinePath, "same-token-successor"), "utf8"), "preserve\n");
});

test("maintenance quarantine preserves a same-owner canonical replacement before rename", async () => {
  const root = await tempRoot("cpb-hub-maintenance-pre-rename-aba");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-pre-rename-aba`,
    incarnation: `${current.pid}:${current.birthId}:stale-pre-rename-aba`,
    birthIdPrecision: "exact" as const,
  };
  const owner = {
    format: "cpb-hub-maintenance/v2",
    ownerToken: "same-owner-pre-rename-token",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  };
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        async beforeQuarantineRename() {
          await rm(lockPath, { recursive: true });
          await mkdir(lockPath);
          await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
          await writeFile(path.join(lockPath, "canonical-successor"), "preserve\n", "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException & { committed?: boolean; successorPreserved?: boolean }) => error.code === "HUB_MAINTENANCE_LOCK_RACE"
      && error.committed === false
      && error.successorPreserved === true,
  );

  assert.equal(await readFile(path.join(lockPath, "canonical-successor"), "utf8"), "preserve\n");
  const residuals = (await readdir(path.dirname(lockPath)))
    .filter((entry) => entry.startsWith(`${path.basename(lockPath)}.stale-`));
  assert.deepEqual(residuals, []);
});

test("maintenance quarantine compares the whole owner after an in-place same-size rewrite", async () => {
  const root = await tempRoot("cpb-hub-maintenance-whole-owner-rewrite");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const staleIdentity = {
    ...current,
    birthId: `${current.birthId}:stale-whole-owner`,
    incarnation: `${current.pid}:${current.birthId}:stale-whole-owner`,
    birthIdPrecision: "exact" as const,
  };
  const originalOwner = {
    format: "cpb-hub-maintenance/v2",
    ownerToken: "same-owner-rewrite-token",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: staleIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: staleIdentity,
  } as const;
  const replacementOwner = { ...originalOwner, operation: "repair" };
  const ownerPath = path.join(lockPath, "owner.json");
  await mkdir(lockPath, { recursive: true });
  await writeFile(ownerPath, `${JSON.stringify(originalOwner)}\n`, "utf8");

  await assert.rejects(
    acquireHubMaintenance(hubRoot, "restore", {
      hooks: {
        async beforeQuarantineRename() {
          await writeFile(ownerPath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
        },
      },
    }),
    (error: Error & { code?: string; committed?: boolean; successorPreserved?: boolean }) => {
      assert.equal(error.code, "HUB_MAINTENANCE_LOCK_RACE");
      assert.equal(error.committed, false);
      assert.equal(error.successorPreserved, true);
      return true;
    },
  );

  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).operation, "repair");
});

test("maintenance release reports a committed quarantine when parent fsync is interrupted", async () => {
  const root = await tempRoot("cpb-hub-maintenance-release-fsync-ambiguity");
  const hubRoot = path.join(root, "hub");
  let quarantinePath = "";
  const injected = Object.assign(new Error("injected quarantine parent fsync failure"), { code: "EIO" });
  const lease = await acquireHubMaintenance(hubRoot, "backup", {
    hooks: {
      beforeQuarantineParentSync(context) {
        quarantinePath = context.quarantinePath;
        throw injected;
      },
    },
  });

  await assert.rejects(
    lease.release(),
    (error: Error & {
      code?: string;
      committed?: boolean;
      committedPath?: string;
      quarantinePreserved?: boolean;
      recoveryPaths?: { lockPath: string; quarantinePath: string };
      cause?: unknown;
    }) => {
      assert.equal(error.code, "HUB_MAINTENANCE_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.committedPath, quarantinePath);
      assert.equal(error.quarantinePreserved, true);
      assert.deepEqual(error.recoveryPaths, { lockPath: lease.lockPath, quarantinePath });
      assert.equal(error.cause, injected);
      return true;
    },
  );
  await assert.rejects(access(lease.lockPath), { code: "ENOENT" });
  await access(path.join(quarantinePath, "owner.json"));
});

test("maintenance release retains its verified quarantine as recovery evidence", async () => {
  const root = await tempRoot("cpb-hub-maintenance-release-evidence");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const lease = await acquireHubMaintenance(hubRoot, "backup");

  assert.equal(await lease.release(), true);
  await assert.rejects(access(lockPath), { code: "ENOENT" });
  const residuals = (await readdir(path.dirname(lockPath)))
    .filter((entry) => entry.startsWith(`${path.basename(lockPath)}.stale-`));
  assert.equal(residuals.length, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(path.dirname(lockPath), residuals[0], "owner.json"), "utf8")).ownerToken,
    lease.owner.ownerToken,
  );
});

test("interrupted restore journal prevents automatic stale-lock theft", async () => {
  const root = await tempRoot("cpb-hub-maintenance-journal");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "dead-restore-owner",
    operation: "restore",
    hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");
  await writeFile(hubRestoreJournalPath(hubRoot), "{}\n", "utf8");

  await assert.rejects(acquireHubMaintenance(hubRoot, "backup"), /requires recovery|already held/);
  await assert.rejects(assertHubWritable(hubRoot), /restore recovery completes/);
  await access(lockPath);
  assert.ok(!hubMaintenanceLockPath(hubRoot).startsWith(`${path.resolve(hubRoot)}${path.sep}`));
});

test("symbolic-link owner and restore journal authorities fail closed", async () => {
  const root = await tempRoot("cpb-hub-maintenance-hostile-symlinks");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const externalOwner = path.join(root, "external-owner.json");
  const externalJournal = path.join(root, "external-journal.json");
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  await mkdir(lockPath, { recursive: true });
  await writeFile(externalOwner, `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "external-owner",
    operation: "backup",
    hubRoot: path.resolve(hubRoot),
    pid: current.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: current,
  })}\n`, "utf8");
  await symlink(externalOwner, path.join(lockPath, "owner.json"));

  await assert.rejects(readHubMaintenance(hubRoot), { code: "HUB_MAINTENANCE_OWNER_INVALID" });
  assert.equal(JSON.parse(await readFile(externalOwner, "utf8")).ownerToken, "external-owner");

  await rm(lockPath, { recursive: true });
  await writeFile(externalJournal, "{}\n", "utf8");
  await symlink(externalJournal, hubRestoreJournalPath(hubRoot));
  await assert.rejects(acquireHubMaintenance(hubRoot, "backup"), { code: "HUB_RESTORE_RECOVERY_REQUIRED" });
  assert.equal(await readFile(externalJournal, "utf8"), "{}\n");
});

test("symbolic-link lock directory and oversized owner metadata fail closed", async () => {
  const root = await tempRoot("cpb-hub-maintenance-hostile-lock-authority");
  const hubRoot = path.join(root, "hub");
  const lockPath = hubMaintenanceLockPath(hubRoot);
  const externalLock = path.join(root, "external-lock");
  await mkdir(externalLock);
  await symlink(externalLock, lockPath, "dir");

  await assert.rejects(readHubMaintenance(hubRoot), { code: "HUB_MAINTENANCE_LOCK_INVALID" });
  await rm(lockPath);
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), Buffer.alloc(64 * 1024 + 1, 0x20));
  await assert.rejects(readHubMaintenance(hubRoot), { code: "HUB_MAINTENANCE_OWNER_INVALID" });
});

test("maintenance aliases to the same physical Hub share one namespace and process fence", async () => {
  const root = await tempRoot("cpb-hub-maintenance-namespace-symlink");
  const authority = path.join(root, "authority");
  const alias = path.join(root, "authority-alias");
  await mkdir(authority);
  await mkdir(path.join(authority, "hub"));
  await symlink(authority, alias, "dir");
  const canonicalHubRoot = path.join(authority, "hub");
  const aliasedHubRoot = path.join(alias, "hub");

  assert.equal(hubMaintenanceLockPath(canonicalHubRoot), hubMaintenanceLockPath(aliasedHubRoot));
  assert.deepEqual(
    _internalHubMaintenanceFenceForTests(canonicalHubRoot),
    _internalHubMaintenanceFenceForTests(aliasedHubRoot),
  );
  const lease = await acquireHubMaintenance(canonicalHubRoot, "backup");
  await assert.rejects(acquireHubMaintenance(aliasedHubRoot, "restore"), { code: "HUB_MAINTENANCE_ACTIVE" });
  assert.equal((await readHubMaintenance(aliasedHubRoot)).owner?.ownerToken, lease.owner.ownerToken);
  assert.equal(await lease.release(), true);
});

test("maintenance lease fences Hub, orchestrator, worker, stores, delegate, and backup entry points", async () => {
  const root = await tempRoot("cpb-hub-maintenance-entry-points");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const lease = await acquireHubMaintenance(hubRoot, "restore drill");
  try {
    await assert.rejects(startHubServer({ cpbRoot, hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true }), /restore drill is active/);
    await assert.rejects(new HubOrchestrator(hubRoot, cpbRoot).start(), /restore drill is active/);
    await assert.rejects(new WorkerSupervisor(hubRoot, cpbRoot).startWorker({ projectId: "flow" }), /restore drill is active/);
    await assert.rejects(new WorkerStore(hubRoot).init(), /restore drill is active/);
    await assert.rejects(new AssignmentStore(hubRoot).init(), /restore drill is active/);
    await assert.rejects(saveRegistry(hubRoot, { projects: {} }), /restore drill is active/);
    await assert.rejects(enqueue(hubRoot, { projectId: "flow", description: "blocked" }), /restore drill is active/);
    await assert.rejects(getHubRuntime(cpbRoot, hubRoot).persist(), /restore drill is active/);
    await assert.rejects(appendCommand(hubRoot, { commandId: "blocked-command", type: "usage_write" }), /restore drill is active/);
    await assert.rejects(createHubBackup({ cpbRoot, hubRoot, output: path.join(root, "backup") }), /already held/);
  } finally {
    await lease.release();
  }
});

test("Redis-backed WorkerSupervisor refuses to pass control-plane credentials to a worker", async () => {
  const root = await tempRoot("cpb-worker-broker-required");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const previousRedis = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  const previousBroker = process.env.CPB_HUB_WORKER_BROKER_URL;
  process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = path.join(root, "private-redis-config.json");
  delete process.env.CPB_HUB_WORKER_BROKER_URL;
  try {
    await assert.rejects(
      new WorkerSupervisor(hubRoot, cpbRoot).startWorker({ projectId: "flow" }),
      { code: "HUB_WORKER_BROKER_REQUIRED" },
    );
  } finally {
    if (previousRedis === undefined) delete process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
    else process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = previousRedis;
    if (previousBroker === undefined) delete process.env.CPB_HUB_WORKER_BROKER_URL;
    else process.env.CPB_HUB_WORKER_BROKER_URL = previousBroker;
  }
});
