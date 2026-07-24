import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import { access, chmod, link, mkdir, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { test as nodeTest, type TestContext } from "node:test";

import {
  acquireLease,
  LEASE_FORMAT_VERSION,
  readLease,
  releaseLease,
  renewLease,
  withInfraLockTestHooksForTests,
  type InfraLockTestHooks,
} from "../server/services/infra.js";
import { captureProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

const infraLockTestHookScope = new AsyncLocalStorage<InfraLockTestHooks>();
const __infraLockTestHooks = new Proxy({} as InfraLockTestHooks, {
  get(_target, property) {
    return Reflect.get(infraLockTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = infraLockTestHookScope.getStore();
    if (!hooks) throw new Error("infra test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = infraLockTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: InfraLockTestHooks = {};
    return infraLockTestHookScope.run(
      hooks,
      () => withInfraLockTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function leaseFile(dataRoot: string, leaseId: string) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const canonicalParent = realpathSync(path.dirname(resolvedDataRoot));
  const canonicalDataRoot = path.join(canonicalParent, path.basename(resolvedDataRoot));
  return path.join(canonicalDataRoot, "leases", `${leaseId}.json`);
}

function fenceKey(file: string, purpose: string) {
  return createHash("sha256")
    .update(`${path.resolve(file)}\0${purpose}\0cpb-file-fence-key-v2`)
    .digest("hex");
}

function fencePorts(file: string, purpose: string) {
  const ports: number[] = [];
  for (let index = 0; ports.length < 32; index += 1) {
    const digest = createHash("sha256")
      .update(`${path.resolve(file)}\0${purpose}\0cpb-file-fence-port-v2\0${index}`)
      .digest();
    const port = 49_152 + (digest.readUInt16BE(0) % 16_384);
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function listen(port: number, handler: (socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket);
  });
  (server as net.Server & { __cpbSockets?: Set<net.Socket> }).__cpbSockets = sockets;
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return server;
}

async function closeServer(server: net.Server) {
  for (const socket of (server as net.Server & { __cpbSockets?: Set<net.Socket> }).__cpbSockets ?? []) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function queryFence(port: number, key: string) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = (matched: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(matched);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(500, () => finish(false));
    socket.on("connect", () => socket.write(`cpb-file-fence-v2? ${key}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) finish(data.trim() === `cpb-file-fence-v2! ${key}`);
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(data.trim() === `cpb-file-fence-v2! ${key}`));
  });
}

async function withDurabilityFault<T>(fault: string, callback: () => Promise<T>) {
  const previous = __infraLockTestHooks.durabilityFault;
  __infraLockTestHooks.durabilityFault = fault;
  try {
    return await callback();
  } finally {
    __infraLockTestHooks.durabilityFault = previous;
  }
}

async function writeLease(dataRoot: string, leaseId: string, ownerToken = "existing-token") {
  const file = leaseFile(dataRoot, leaseId);
  const ownerIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(ownerIdentity);
  await writeJson(file, {
    formatVersion: LEASE_FORMAT_VERSION,
    leaseId,
    jobId: "job-existing",
    phase: "execute",
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken,
    ownerIdentity,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:01.000Z",
  });
  return file;
}

async function writeLiveLock(file: string) {
  const ownerIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(ownerIdentity);
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeJson(path.join(lockDir, "lock.json"), {
    version: 1,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken: "live-lock-token",
    ownerIdentity: { ...ownerIdentity, birthIdPrecision: "exact" },
    targetGeneration: null,
  });
}

async function writeDeadLock(file: string) {
  const missingPid = 999_999;
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeJson(path.join(lockDir, "lock.json"), {
    version: 1,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ownerPid: missingPid,
    ownerHost: hostname(),
    ownerToken: "dead-lock-token",
    ownerIdentity: {
      pid: missingPid,
      birthId: "missing-process",
      incarnation: `${missingPid}:missing-process`,
      capturedAt: "2026-01-01T00:00:00.000Z",
      birthIdPrecision: "exact",
    },
    targetGeneration: null,
  });
}

test("local lease lock refuses to evict a live owner merely because metadata passed TTL", async () => {
  const root = await tempRoot("cpb-lease-lock-live-owner");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-live-lock");
  await writeLiveLock(file);

  await assert.rejects(
    acquireLease(root, {
      dataRoot,
      leaseId: "lease-live-lock",
      jobId: "job-new",
      phase: "execute",
      ttlMs: 60_000,
      lockTtlMs: 25,
      now: new Date("2026-01-01T00:01:00.000Z"),
    }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKBUSY",
  );

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.ownerToken, "existing-token");
});

test("local lease lock fails closed on symlink lock state and preserves the lease", async () => {
  const root = await tempRoot("cpb-lease-lock-symlink");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-symlink-lock");
  const target = path.join(root, "attacker-lock-target");
  await mkdir(target, { recursive: true });
  await symlink(target, `${file}.lock`, "dir");

  await assert.rejects(
    readLease(root, "lease-symlink-lock", { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKSYMLINK",
  );

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.ownerToken, "existing-token");
});

test("local lease lock refuses a lock metadata symlink swapped in after lstat", async () => {
  const root = await tempRoot("cpb-lease-lock-metadata-symlink-race");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-metadata-symlink-race");
  await writeLiveLock(file);
  const metadataFile = path.join(`${file}.lock`, "lock.json");
  const preservedMetadata = path.join(root, "preserved-lock.json");

  __infraLockTestHooks.afterLockMetadataLstat = async () => {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
    await rename(metadataFile, preservedMetadata);
    await symlink(preservedMetadata, metadataFile);
  };
  try {
    await assert.rejects(
      readLease(root, "lease-metadata-symlink-race", { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
    );
  } finally {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
  }

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.ownerToken, "existing-token");
});

test("local lease lock recovers only an aged incomplete lock directory", async () => {
  const root = await tempRoot("cpb-lease-lock-incomplete-aged");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-incomplete-aged";
  const file = await writeLease(dataRoot, leaseId);
  const lockDir = `${file}.lock`;
  await mkdir(lockDir);
  await utimes(lockDir, new Date(0), new Date(0));

  const lease = await readLease(root, leaseId, { dataRoot, lockTtlMs: 25 });
  assert.equal(lease?.leaseId, leaseId);
  const residuals = (await readdir(path.dirname(lockDir))).filter((name) => name.includes(`${leaseId}.json.lock.incomplete.`));
  assert.equal(residuals.length, 1);
});

test("local lease lock preserves a fresh incomplete lock as busy", async () => {
  const root = await tempRoot("cpb-lease-lock-incomplete-fresh");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-incomplete-fresh";
  const file = await writeLease(dataRoot, leaseId);
  const lockDir = `${file}.lock`;
  await mkdir(lockDir);

  await assert.rejects(
    readLease(root, leaseId, { dataRoot, lockTtlMs: 25 }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKBUSY",
  );
  assert.deepEqual(await readdir(lockDir), []);
});

test("local lease lock refuses a regular metadata replacement between lstat and open", async () => {
  const root = await tempRoot("cpb-lease-lock-metadata-replacement-race");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-metadata-replacement-race");
  await writeLiveLock(file);
  const metadataFile = path.join(`${file}.lock`, "lock.json");
  const replacement = path.join(root, "replacement-lock.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  await writeJson(replacement, { ...metadata, ownerToken: "replacement-lock-token" });

  __infraLockTestHooks.afterLockMetadataLstat = async () => {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
    await rename(replacement, metadataFile);
  };
  try {
    await assert.rejects(
      readLease(root, "lease-metadata-replacement-race", { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
    );
  } finally {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
  }

  assert.equal(JSON.parse(await readFile(metadataFile, "utf8")).ownerToken, "replacement-lock-token");
  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "existing-token");
});

test("local lease lock refuses an in-place metadata ctime generation change", async () => {
  const root = await tempRoot("cpb-lease-lock-metadata-ctime-race");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-metadata-ctime-race");
  await writeLiveLock(file);
  const metadataFile = path.join(`${file}.lock`, "lock.json");

  __infraLockTestHooks.afterLockMetadataLstat = async () => {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
    await chmod(metadataFile, 0o600);
  };
  try {
    await assert.rejects(
      readLease(root, "lease-metadata-ctime-race", { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
    );
  } finally {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
  }

  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "existing-token");
});

test("local lease read refuses a symlink lease record", async () => {
  const root = await tempRoot("cpb-lease-record-symlink");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-record-symlink";
  const file = leaseFile(dataRoot, leaseId);
  const target = path.join(root, "attacker-lease.json");
  await writeJson(target, {
    leaseId,
    jobId: "job-attacker",
    phase: "execute",
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken: "attacker-token",
    expiresAt: "2026-01-01T00:00:01.000Z",
  });
  await mkdir(path.dirname(file), { recursive: true });
  await symlink(target, file);

  await assert.rejects(
    readLease(root, leaseId, { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELEASEINVALID",
  );

  assert.equal(JSON.parse(await readFile(target, "utf8")).ownerToken, "attacker-token");
});

test("local lease read rejects oversized lease records without buffering", async () => {
  const root = await tempRoot("cpb-lease-record-oversized");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-record-oversized";
  const file = leaseFile(dataRoot, leaseId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(64 * 1024 + 1, 0x20));

  await assert.rejects(
    readLease(root, leaseId, { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELEASEINVALID",
  );
});

test("local lease read refuses a same-token lease replacement between lstat and open", async () => {
  const root = await tempRoot("cpb-lease-record-replacement-race");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-record-replacement-race";
  const file = await writeLease(dataRoot, leaseId, "stable-token");
  const preserved = path.join(root, "preserved-lease.json");
  const replacement = path.join(root, "replacement-lease.json");
  const lease = JSON.parse(await readFile(file, "utf8"));
  await writeJson(replacement, { ...lease, ownerToken: "stable-token", jobId: "job-replacement" });

  __infraLockTestHooks.afterLeaseLstat = async () => {
    __infraLockTestHooks.afterLeaseLstat = undefined;
    await rename(file, preserved);
    await rename(replacement, file);
  };
  try {
    await assert.rejects(
      readLease(root, leaseId, { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "ELEASEINVALID",
    );
  } finally {
    __infraLockTestHooks.afterLeaseLstat = undefined;
  }

  assert.equal(JSON.parse(await readFile(file, "utf8")).jobId, "job-replacement");
  assert.equal(JSON.parse(await readFile(preserved, "utf8")).jobId, "job-existing");
});

test("local lease lock rejects oversized owner metadata without buffering or eviction", async () => {
  const root = await tempRoot("cpb-lease-lock-metadata-oversized");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-metadata-oversized");
  await writeLiveLock(file);
  await writeFile(path.join(`${file}.lock`, "lock.json"), Buffer.alloc(16 * 1024 + 1, 0x20));

  await assert.rejects(
    readLease(root, "lease-metadata-oversized", { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
  );

  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "existing-token");
});

test("local lease release preserves a same-token replacement lock directory", async () => {
  const root = await tempRoot("cpb-lease-lock-same-token-successor");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-lock-same-token-successor";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-new",
    phase: "execute",
    ttlMs: 60_000,
    lockTtlMs: 500,
  });
  const file = leaseFile(dataRoot, leaseId);
  const lockDir = `${file}.lock`;
  const preservedLockDir = path.join(root, "preserved-lock-dir");
  const metadataFile = path.join(lockDir, "lock.json");
  let replaced = false;

  __infraLockTestHooks.afterLockMetadataLstat = async () => {
    if (replaced) return;
    replaced = true;
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    await rename(lockDir, preservedLockDir);
    await mkdir(lockDir);
    await writeJson(metadataFile, {
      ...metadata,
      ownerToken: lease.ownerToken,
      acquiredAt: "2026-01-01T00:00:02.000Z",
    });
  };
  try {
    await assert.rejects(
      releaseLease(root, leaseId, {
        dataRoot,
        ownerToken: lease.ownerToken,
        lockTtlMs: 500,
      }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
    );
  } finally {
    __infraLockTestHooks.afterLockMetadataLstat = undefined;
  }

  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, lease.ownerToken);
  assert.equal(JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8")).ownerToken, lease.ownerToken);
  await rm(preservedLockDir, { recursive: true, force: true });
});

test("local lease lock fails closed on corrupt owner metadata and preserves the lease", async () => {
  const root = await tempRoot("cpb-lease-lock-corrupt");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-corrupt-lock");
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "lock.json"), "{not-json\n", "utf8");

  await assert.rejects(
    readLease(root, "lease-corrupt-lock", { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
  );

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.ownerToken, "existing-token");
});

test("local lease lock fails closed on persisted coarse owner identity and preserves the lease", async () => {
  const root = await tempRoot("cpb-lease-lock-coarse");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-coarse-lock");
  const ownerIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(ownerIdentity);
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeJson(path.join(lockDir, "lock.json"), {
    version: 1,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken: "coarse-lock-token",
    ownerIdentity: { ...ownerIdentity, birthIdPrecision: "coarse" },
    targetGeneration: null,
  });

  await assert.rejects(
    readLease(root, "lease-coarse-lock", { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
  );

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.ownerToken, "existing-token");
});

test("local lease lock rejects string owner PIDs without evicting the lock", async () => {
  const root = await tempRoot("cpb-lease-lock-string-owner-pid");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-lock-string-owner-pid");
  await writeLiveLock(file);
  const metadataFile = path.join(`${file}.lock`, "lock.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  await writeJson(metadataFile, { ...metadata, ownerPid: String(metadata.ownerPid) });

  await assert.rejects(
    readLease(root, "lease-lock-string-owner-pid", { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELOCKINVALID",
  );
  assert.equal(JSON.parse(await readFile(metadataFile, "utf8")).ownerPid, String(process.pid));
  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "existing-token");
});

test("local lease recovery serializes two recoverers and a third contender without ABA overwrite", async () => {
  const root = await tempRoot("cpb-lease-lock-three-party");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-three-party", "stale-token");
  await writeDeadLock(file);

  const attempts = await Promise.allSettled([
    acquireLease(root, {
      dataRoot,
      leaseId: "lease-three-party",
      jobId: "job-a",
      phase: "execute",
      ttlMs: 60_000,
      lockTtlMs: 10_000,
      now: new Date("2026-01-01T00:01:00.000Z"),
    }),
    acquireLease(root, {
      dataRoot,
      leaseId: "lease-three-party",
      jobId: "job-b",
      phase: "execute",
      ttlMs: 60_000,
      lockTtlMs: 10_000,
      now: new Date("2026-01-01T00:01:00.000Z"),
    }),
    acquireLease(root, {
      dataRoot,
      leaseId: "lease-three-party",
      jobId: "job-c",
      phase: "execute",
      ttlMs: 60_000,
      lockTtlMs: 10_000,
      now: new Date("2026-01-01T00:01:00.000Z"),
    }),
  ]);

  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  const losers = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 2);
  assert.ok(losers.every((attempt) =>
    attempt.status === "rejected" &&
    (attempt.reason as NodeJS.ErrnoException).code === "EEXIST"
  ));
  const finalLease = await readLease(root, "lease-three-party", { dataRoot });
  assert.equal(finalLease?.ownerToken, winners[0].status === "fulfilled" ? winners[0].value.ownerToken : null);
  assert.match(String(finalLease?.jobId), /^job-[abc]$/);
});

test("local lease recovery preserves an empty successor and the quarantined predecessor", async () => {
  const root = await tempRoot("cpb-lease-lock-empty-successor");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-empty-successor", "stale-token");
  await writeDeadLock(file);
  const lockDir = `${file}.lock`;
  let quarantineDir = "";

  __infraLockTestHooks.afterQuarantineRename = async (context) => {
    __infraLockTestHooks.afterQuarantineRename = undefined;
    quarantineDir = context.quarantineDir;
    await mkdir(context.lockDir);
    throw new Error("force quarantine restoration");
  };
  try {
    await assert.rejects(
      readLease(root, "lease-empty-successor", { dataRoot }),
      (error: NodeJS.ErrnoException & { successorPreserved?: boolean }) => {
        assert.ok(error instanceof AggregateError);
        const failure = error as AggregateError & { code?: string; successorPreserved?: boolean };
        assert.equal(failure.code, "ELOCKOWNER");
        assert.equal(failure.successorPreserved, true);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.afterQuarantineRename = undefined;
  }

  assert.ok(quarantineDir);
  assert.deepEqual(await readdir(lockDir), []);
  assert.equal(
    JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")).ownerToken,
    "dead-lock-token",
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "stale-token");
});

test("local lease recovery preserves quarantine instead of reconstructing canonical lock", async () => {
  const root = await tempRoot("cpb-lease-lock-preserve-quarantine");
  const dataRoot = path.join(root, "runtime");
  const file = await writeLease(dataRoot, "lease-preserve-quarantine", "stale-token");
  await writeDeadLock(file);
  const lockDir = `${file}.lock`;
  let quarantineDir = "";

  __infraLockTestHooks.afterQuarantineRename = async (context) => {
    __infraLockTestHooks.afterQuarantineRename = undefined;
    quarantineDir = context.quarantineDir;
    throw new Error("force preserve-only recovery");
  };
  try {
    await assert.rejects(
      readLease(root, "lease-preserve-quarantine", { dataRoot }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        const failure = error as AggregateError & {
          code?: unknown;
          committed?: unknown;
          successorPreserved?: unknown;
          recoveryPaths?: { quarantine?: unknown };
        };
        assert.equal(failure.code, "ELOCKRESTORE");
        assert.equal(failure.committed, true);
        assert.equal(failure.successorPreserved, false);
        assert.equal(failure.recoveryPaths?.quarantine, quarantineDir);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.afterQuarantineRename = undefined;
  }

  await assert.rejects(readFile(path.join(lockDir, "lock.json"), "utf8"), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")).ownerToken, "dead-lock-token");
  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "stale-token");
});

test("local lease recovery reports committed lock removal ambiguity with recovery path", async () => {
  const root = await tempRoot("cpb-lease-lock-remove-ambiguity");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-lock-remove-ambiguity";
  const file = await writeLease(dataRoot, leaseId, "stale-token");
  await writeDeadLock(file);

  await assert.rejects(
    withDurabilityFault(`after-lock-remove:${leaseId}.json`, () => readLease(root, leaseId, { dataRoot })),
    (error: NodeJS.ErrnoException & {
      committed?: unknown;
      committedPath?: unknown;
      recoveryPaths?: { quarantine?: unknown };
    }) => {
      assert.equal(error.code, "DURABLE_LOCK_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.committedPath, error.recoveryPaths?.quarantine);
      assert.match(String(error.committedPath), /\.lock\.dead\./);
      return true;
    },
  );

  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "stale-token");
});

test("local lease acquisition fails closed before writing when exact owner identity is unavailable", async () => {
  const root = await tempRoot("cpb-lease-owner-identity-unavailable");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-owner-identity-unavailable";
  __infraLockTestHooks.captureProcessIdentity = () => null;
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-new",
        phase: "execute",
        ttlMs: 60_000,
        lockTtlMs: 500,
      }),
      (error: NodeJS.ErrnoException & { ownerPid?: number; context?: string }) => {
        assert.equal(error.code, "PROCESS_IDENTITY_UNAVAILABLE");
        assert.equal(error.ownerPid, process.pid);
        assert.ok(["lease file lock acquisition", "local lease acquisition"].includes(String(error.context)));
        return true;
      },
    );
    await assert.rejects(readFile(leaseFile(dataRoot, leaseId), "utf8"));
  } finally {
    __infraLockTestHooks.captureProcessIdentity = undefined;
  }
});

test("Redis lease acquisition fails closed before compare-and-swap when exact owner identity is unavailable", async () => {
  const root = await tempRoot("cpb-lease-redis-owner-identity-unavailable");
  const dataRoot = path.join(root, "runtime");
  let casCalls = 0;
  __infraLockTestHooks.captureProcessIdentity = () => null;
  __infraLockTestHooks.redisLeaseBackend = () => ({
    readStateRecord: async () => ({ data: null, revision: "r0" }),
    serverTimeMs: async () => Date.now(),
    compareAndSwapStateRecord: async () => {
      casCalls += 1;
      return { committed: true, revision: "r1" };
    },
  } as never);
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId: "lease-redis-owner-identity-unavailable",
        jobId: "job-new",
        phase: "execute",
        ttlMs: 60_000,
      }),
      (error: NodeJS.ErrnoException & { context?: string }) => {
        assert.equal(error.code, "PROCESS_IDENTITY_UNAVAILABLE");
        assert.equal(error.context, "Redis lease acquisition");
        return true;
      },
    );
    assert.equal(casCalls, 0, "Redis lease state must not be created or updated on capture failure");
  } finally {
    __infraLockTestHooks.captureProcessIdentity = undefined;
    __infraLockTestHooks.redisLeaseBackend = undefined;
  }
});

test("Redis lease acquisition persists an exact owner identity", async () => {
  const root = await tempRoot("cpb-lease-redis-owner-identity");
  const dataRoot = path.join(root, "runtime");
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);
  let persisted: unknown = null;
  __infraLockTestHooks.captureProcessIdentity = () => identity;
  __infraLockTestHooks.redisLeaseBackend = () => ({
    readStateRecord: async () => ({ data: null, revision: "r0" }),
    serverTimeMs: async () => Date.now(),
    compareAndSwapStateRecord: async (_field: string, _revision: string, value: unknown) => {
      persisted = value;
      return { committed: true, revision: "r1" };
    },
  } as never);
  try {
    const lease = await acquireLease(root, {
      dataRoot,
      leaseId: "lease-redis-owner-identity",
      jobId: "job-new",
      phase: "execute",
      ttlMs: 60_000,
    });
    assert.deepEqual(lease.ownerIdentity, identity);
    assert.deepEqual((persisted as { ownerIdentity?: unknown }).ownerIdentity, identity);
  } finally {
    __infraLockTestHooks.captureProcessIdentity = undefined;
    __infraLockTestHooks.redisLeaseBackend = undefined;
  }
});

test("local lease write reports committed durability ambiguity after publish", async () => {
  const root = await tempRoot("cpb-lease-write-ambiguity");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-write-ambiguity";

  await assert.rejects(
    withDurabilityFault(`after-json-rename:${leaseId}.json`, () => acquireLease(root, {
      dataRoot,
      leaseId,
      jobId: "job-new",
      phase: "execute",
      ttlMs: 60_000,
      lockTtlMs: 500,
    })),
    (error: NodeJS.ErrnoException & { committed?: unknown; path?: unknown; recoveryPaths?: { path?: unknown } }) => {
      assert.equal(error.code, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.path, leaseFile(dataRoot, leaseId));
      assert.equal(error.recoveryPaths?.path, leaseFile(dataRoot, leaseId));
      return true;
    },
  );

  const raw = JSON.parse(await readFile(leaseFile(dataRoot, leaseId), "utf8"));
  assert.equal(raw.leaseId, leaseId);
  assert.equal(raw.jobId, "job-new");
});

test("local lease release reports committed removal ambiguity after preserve-only isolation", async () => {
  const root = await tempRoot("cpb-lease-remove-ambiguity");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-remove-ambiguity";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-new",
    phase: "execute",
    ttlMs: 60_000,
    lockTtlMs: 500,
  });

  await assert.rejects(
    withDurabilityFault(`after-lease-remove:${leaseId}.json`, () => releaseLease(root, leaseId, {
      dataRoot,
      ownerToken: lease.ownerToken,
      lockTtlMs: 500,
    })),
    (error: NodeJS.ErrnoException & {
      committed?: unknown;
      committedPath?: unknown;
      path?: unknown;
      recoveryPaths?: { quarantine?: unknown };
    }) => {
      assert.equal(error.code, "DURABLE_LEASE_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.path, leaseFile(dataRoot, leaseId));
      assert.equal(error.committedPath, error.recoveryPaths?.quarantine);
      assert.match(String(error.committedPath), /\.json\.removed-/);
      return true;
    },
  );

  assert.equal(await readLease(root, leaseId, { dataRoot }), null);
});

test("local lease TCP fence skips unrelated listeners on derived ports", async () => {
  const root = await tempRoot("cpb-lease-fence-unrelated");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-fence-unrelated";
  const file = leaseFile(dataRoot, leaseId);
  await mkdir(path.dirname(file), { recursive: true });
  const canonicalFile = path.join(await realpath(path.dirname(file)), path.basename(file));
  const [port] = fencePorts(canonicalFile, "lease");
  const unrelated = await listen(port, (socket) => socket.end("not-cpb\n"));
  try {
    const lease = await acquireLease(root, {
      dataRoot,
      leaseId,
      jobId: "job-new",
      phase: "execute",
      ttlMs: 60_000,
      lockTtlMs: 500,
    });
    assert.equal(lease.leaseId, leaseId);
  } finally {
    await closeServer(unrelated);
  }
});

test("local lease TCP fence fails closed on same owner key contention", async () => {
  const root = await tempRoot("cpb-lease-fence-same-key");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-fence-same-key";
  const file = leaseFile(dataRoot, leaseId);
  await mkdir(path.dirname(file), { recursive: true });
  const canonicalFile = path.join(await realpath(path.dirname(file)), path.basename(file));
  const key = fenceKey(canonicalFile, "lease");
  const [port] = fencePorts(canonicalFile, "lease");
  const contender = await listen(port, (socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n") && data.trim() === `cpb-file-fence-v2? ${key}`) {
        socket.end(`cpb-file-fence-v2! ${key}\n`);
      }
    });
  });
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-new",
        phase: "execute",
        ttlMs: 60_000,
        lockTtlMs: 50,
      }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKBUSY",
    );
  } finally {
    await closeServer(contender);
  }
});

test("infra test hooks remain isolated across overlapping async scopes", async () => {
  const root = await tempRoot("cpb-infra-hook-isolation");
  const dataRootA = path.join(root, "runtime-a");
  const dataRootB = path.join(root, "runtime-b");
  const fileA = await writeLease(dataRootA, "lease-hook-a", "token-a");
  const fileB = await writeLease(dataRootB, "lease-hook-b", "token-b");
  let ready = 0;
  let releaseHooks!: () => void;
  const hooksOverlap = new Promise<void>((resolve) => { releaseHooks = resolve; });
  const seen: string[] = [];

  const readInScope = (expectedFile: string, leaseId: string, dataRoot: string) =>
    withInfraLockTestHooksForTests({
      afterLeaseLstat: async ({ leaseFile: observed }) => {
        assert.equal(observed, expectedFile);
        seen.push(leaseId);
        ready += 1;
        if (ready === 2) releaseHooks();
        await hooksOverlap;
      },
    }, () => readLease(root, leaseId, { dataRoot }));

  const [leaseA, leaseB] = await Promise.all([
    readInScope(fileA, "lease-hook-a", dataRootA),
    readInScope(fileB, "lease-hook-b", dataRootB),
  ]);
  assert.equal(leaseA?.ownerToken, "token-a");
  assert.equal(leaseB?.ownerToken, "token-b");
  assert.deepEqual(seen.sort(), ["lease-hook-a", "lease-hook-b"]);
});

test("local lease read rejects hard-linked records without altering either name", async () => {
  const root = await tempRoot("cpb-lease-record-hardlink");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-record-hardlink";
  const file = await writeLease(dataRoot, leaseId, "hardlink-token");
  const alias = path.join(root, "lease-alias.json");
  await link(file, alias);

  await assert.rejects(
    readLease(root, leaseId, { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "ELEASEINVALID",
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).ownerToken, "hardlink-token");
  assert.equal(JSON.parse(await readFile(alias, "utf8")).ownerToken, "hardlink-token");
});

test("local lease storage rejects a symlinked leases directory", async () => {
  const root = await tempRoot("cpb-lease-parent-symlink");
  const dataRoot = path.join(root, "runtime");
  const external = path.join(root, "external-leases");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(external, { recursive: true });
  const leaseId = "lease-parent-symlink";
  const externalFile = path.join(external, `${leaseId}.json`);
  await writeJson(externalFile, {
    leaseId,
    expiresAt: "2026-01-01T00:00:01.000Z",
  });
  await symlink(external, path.join(dataRoot, "leases"), "dir");

  await assert.rejects(
    readLease(root, leaseId, { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "EDIRECTORYUNSAFE",
  );
  assert.equal(JSON.parse(await readFile(externalFile, "utf8")).leaseId, leaseId);
});

test("local lease publication preserves a successor installed before publish rename", async () => {
  const root = await tempRoot("cpb-lease-publish-successor");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-publish-successor";
  const file = await writeLease(dataRoot, leaseId, "predecessor-token");
  const predecessor = path.join(root, "predecessor-lease.json");

  __infraLockTestHooks.beforeJsonPublishRename = async ({ file: target }) => {
    if (target !== file) return;
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    const record = JSON.parse(await readFile(file, "utf8"));
    await rename(file, predecessor);
    await writeJson(file, {
      ...record,
      jobId: "job-successor",
      heartbeatAt: "2026-01-01T00:02:00.000Z",
      expiresAt: "2026-01-01T00:03:00.000Z",
    });
  };
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-contender",
        phase: "execute",
        ttlMs: 60_000,
        now: new Date("2026-01-01T00:01:00.000Z"),
      }),
      (error: NodeJS.ErrnoException & { successorPreserved?: unknown }) => {
        assert.equal(error.code, "DURABLE_JSON_TARGET_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).jobId, "job-successor");
  assert.equal(JSON.parse(await readFile(predecessor, "utf8")).jobId, "job-existing");
});

test("local lease publication refuses a hard-linked temp and preserves both names", async () => {
  const root = await tempRoot("cpb-lease-publish-temp-hardlink");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-publish-temp-hardlink";
  const file = leaseFile(dataRoot, leaseId);
  const alias = path.join(root, "temp-alias.json");
  let tempPath = "";
  __infraLockTestHooks.beforeJsonPublishRename = async ({ file: target, tempFile }) => {
    if (target !== file) return;
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    tempPath = tempFile;
    await link(tempFile, alias);
  };
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-new",
        phase: "execute",
        ttlMs: 60_000,
      }),
      (error: NodeJS.ErrnoException & { successorPreserved?: unknown }) => {
        assert.equal(error.code, "DURABLE_JSON_TEMP_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
  }
  assert.ok(tempPath);
  assert.equal(JSON.parse(await readFile(tempPath, "utf8")).leaseId, leaseId);
  assert.equal(JSON.parse(await readFile(alias, "utf8")).leaseId, leaseId);
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
});

test("local lease release preserves a same-token successor installed before isolation", async () => {
  const root = await tempRoot("cpb-lease-remove-successor-before");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-remove-successor-before";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-predecessor",
    phase: "execute",
    ttlMs: 60_000,
  });
  const file = leaseFile(dataRoot, leaseId);
  const predecessor = path.join(root, "predecessor.json");
  __infraLockTestHooks.beforeDurableRemoveRename = async ({ target }) => {
    __infraLockTestHooks.beforeDurableRemoveRename = undefined;
    const record = JSON.parse(await readFile(target, "utf8"));
    await rename(target, predecessor);
    await writeJson(target, { ...record, jobId: "job-successor" });
  };
  try {
    await assert.rejects(
      releaseLease(root, leaseId, { dataRoot, ownerToken: lease.ownerToken }),
      (error: NodeJS.ErrnoException & { successorPreserved?: unknown }) => {
        assert.equal(error.code, "DURABLE_REMOVE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.beforeDurableRemoveRename = undefined;
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).jobId, "job-successor");
  assert.equal(JSON.parse(await readFile(predecessor, "utf8")).jobId, "job-predecessor");
});

test("local lease ownership never falls back to process-global token state", async () => {
  const root = await tempRoot("cpb-lease-owner-token-explicit");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-owner-token-explicit";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-owner",
    phase: "execute",
    ttlMs: 60_000,
  });

  await assert.rejects(
    releaseLease(root, leaseId, { dataRoot }),
    /lease owner mismatch/,
  );
  assert.equal((await readLease(root, leaseId, { dataRoot }))?.ownerToken, lease.ownerToken);
  await releaseLease(root, leaseId, { dataRoot, ownerToken: lease.ownerToken });
  assert.equal(await readLease(root, leaseId, { dataRoot }), null);
});

test("local lease release never pathname-deletes a successor created after isolation", async () => {
  const root = await tempRoot("cpb-lease-remove-successor-after");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-remove-successor-after";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-predecessor",
    phase: "execute",
    ttlMs: 60_000,
  });
  const file = leaseFile(dataRoot, leaseId);
  let quarantinePath = "";
  __infraLockTestHooks.afterDurableRemoveRename = async ({ target, quarantinePath: quarantine }) => {
    __infraLockTestHooks.afterDurableRemoveRename = undefined;
    quarantinePath = quarantine;
    const record = JSON.parse(await readFile(quarantine, "utf8"));
    await writeJson(target, { ...record, jobId: "job-successor" });
  };
  try {
    await releaseLease(root, leaseId, { dataRoot, ownerToken: lease.ownerToken });
  } finally {
    __infraLockTestHooks.afterDurableRemoveRename = undefined;
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).jobId, "job-successor");
  assert.equal(JSON.parse(await readFile(quarantinePath, "utf8")).jobId, "job-predecessor");
});

test("committed lock metadata ambiguity isolates the exact owned lock before releasing its process fence", async () => {
  const root = await tempRoot("cpb-lock-publication-cleanup");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-lock-publication-cleanup";
  let observedFenceDuringCleanup = false;

  __infraLockTestHooks.beforeProcessFenceRelease = async ({ canonicalFile, lockDir, acquired }) => {
    if (acquired || path.basename(canonicalFile) !== `${leaseId}.json`) return;
    __infraLockTestHooks.beforeProcessFenceRelease = undefined;
    await assert.rejects(access(lockDir), { code: "ENOENT" });
    const key = fenceKey(canonicalFile, "lease");
    const matches = await Promise.all(fencePorts(canonicalFile, "lease").map((port) => queryFence(port, key)));
    assert.equal(matches.filter(Boolean).length, 1, "the exact process fence must remain live through lock isolation");
    observedFenceDuringCleanup = true;
  };

  try {
    await assert.rejects(
      withDurabilityFault("after-json-rename:lock.json", () => acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-first",
        phase: "execute",
        ttlMs: 60_000,
      })),
      (error: NodeJS.ErrnoException & {
        lockCleanupCommitted?: unknown;
        canonicalLockRetained?: unknown;
        recoveryPaths?: { quarantine?: unknown };
      }) => {
        assert.equal(error.code, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
        assert.equal(error.lockCleanupCommitted, true);
        assert.equal(error.canonicalLockRetained, false);
        assert.match(String(error.recoveryPaths?.quarantine), /\.lock\.incomplete\./);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.beforeProcessFenceRelease = undefined;
  }

  assert.equal(observedFenceDuringCleanup, true);
  await assert.rejects(access(`${leaseFile(dataRoot, leaseId)}.lock`));
  const recovered = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-second",
    phase: "execute",
    ttlMs: 60_000,
  });
  assert.equal(recovered.jobId, "job-second");
  await releaseLease(root, leaseId, { dataRoot, ownerToken: recovered.ownerToken });
});

test("lease storage rejects a symlink in the supplied dataRoot ancestor chain", async () => {
  const root = await tempRoot("cpb-lease-data-root-ancestor");
  const external = path.join(root, "external");
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(root, "linked"), "dir");
  const dataRoot = path.join(root, "linked", "runtime");

  await assert.rejects(
    readLease(root, "lease-symlinked-data-root", { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "EDIRECTORYUNSAFE",
  );
  await assert.rejects(access(path.join(external, "runtime", "leases")));
});

test("lease storage rejects a symlink used as the shared cpbRoot and dataRoot anchor", async () => {
  const root = await tempRoot("cpb-lease-shared-anchor-symlink");
  const external = path.join(root, "external");
  const shared = path.join(root, "shared");
  await mkdir(external, { recursive: true });
  await symlink(external, shared, "dir");

  await assert.rejects(
    readLease(
      path.join(shared, "project"),
      "lease-shared-anchor-symlink",
      { dataRoot: path.join(shared, "runtime") },
    ),
    (error: NodeJS.ErrnoException) => error.code === "EDIRECTORYUNSAFE",
  );
  await assert.rejects(access(path.join(external, "runtime")));
});

test("lease lock rejects an ancestor alias installed after canonical fence resolution", async () => {
  const root = await tempRoot("cpb-lease-fence-authority-alias-race");
  const dataRoot = path.join(root, "runtime");
  const moved = path.join(root, "runtime-predecessor");
  const leaseId = "lease-fence-authority-alias-race";
  let hookCalled = false;
  __infraLockTestHooks.afterCanonicalFenceResolutionBeforeAuthorityOpen = async ({ canonicalFile }) => {
    if (path.basename(canonicalFile) !== `${leaseId}.json`) return;
    __infraLockTestHooks.afterCanonicalFenceResolutionBeforeAuthorityOpen = undefined;
    await rename(dataRoot, moved);
    await symlink(moved, dataRoot, "dir");
    hookCalled = true;
  };
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-alias-race",
        phase: "execute",
        ttlMs: 60_000,
      }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKPARENT",
    );
  } finally {
    __infraLockTestHooks.afterCanonicalFenceResolutionBeforeAuthorityOpen = undefined;
  }
  assert.equal(hookCalled, true);
  await assert.rejects(access(path.join(moved, "leases", `${leaseId}.json`)));
  await assert.rejects(access(`${path.join(moved, "leases", `${leaseId}.json`)}.lock`));
});

test("lease lock rejects a same-path directory successor before authority open", async () => {
  const root = await tempRoot("cpb-lease-fence-authority-successor-race");
  const dataRoot = path.join(root, "runtime");
  const moved = path.join(root, "runtime-predecessor");
  const leaseId = "lease-fence-authority-successor-race";
  __infraLockTestHooks.afterCanonicalFenceResolutionBeforeAuthorityOpen = async ({ canonicalFile }) => {
    if (path.basename(canonicalFile) !== `${leaseId}.json`) return;
    __infraLockTestHooks.afterCanonicalFenceResolutionBeforeAuthorityOpen = undefined;
    await rename(dataRoot, moved);
    await mkdir(path.join(dataRoot, "leases"), { recursive: true });
  };
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-successor-race",
        phase: "execute",
        ttlMs: 60_000,
      }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKPARENT",
    );
  } finally {
    __infraLockTestHooks.afterCanonicalFenceResolutionBeforeAuthorityOpen = undefined;
  }
  await assert.rejects(access(path.join(moved, "leases", `${leaseId}.json`)));
  await assert.rejects(access(path.join(dataRoot, "leases", `${leaseId}.json`)));
});

test("lease ancestor replacement during publication cannot redirect the fenced callback", async () => {
  const root = await tempRoot("cpb-lease-ancestor-aba");
  const dataRoot = path.join(root, "runtime");
  const moved = path.join(root, "runtime-predecessor");
  const leaseId = "lease-ancestor-aba";
  const expectedFile = leaseFile(dataRoot, leaseId);
  __infraLockTestHooks.beforeJsonPublishRename = async ({ file }) => {
    if (file !== expectedFile) return;
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    await rename(dataRoot, moved);
    await mkdir(path.join(dataRoot, "leases"), { recursive: true });
  };
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-ancestor-aba",
        phase: "execute",
        ttlMs: 60_000,
      }),
      (error: NodeJS.ErrnoException) => [
        "DURABLE_JSON_PARENT_UNSAFE",
        "DURABLE_JSON_TEMP_CLEANUP_FAILED",
      ].includes(String(error.code)),
    );
  } finally {
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
  }
  await assert.rejects(access(expectedFile));
  await assert.rejects(access(path.join(moved, "leases", `${leaseId}.json`)));
});

test("lease ancestor alias replacement cannot split the canonical fence from callback path", async () => {
  const root = await tempRoot("cpb-lease-ancestor-alias");
  const dataRoot = path.join(root, "runtime");
  const moved = path.join(root, "runtime-predecessor");
  const leaseId = "lease-ancestor-alias";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-ancestor-alias",
    phase: "execute",
    ttlMs: 60_000,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  const expectedFile = leaseFile(dataRoot, leaseId);
  __infraLockTestHooks.beforeJsonPublishRename = async ({ file }) => {
    if (file !== expectedFile) return;
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    await rename(dataRoot, moved);
    await symlink(moved, dataRoot, "dir");
  };
  try {
    await assert.rejects(
      renewLease(root, leaseId, {
        dataRoot,
        ownerToken: lease.ownerToken,
        ttlMs: 60_000,
        now: new Date("2026-01-01T00:00:30.000Z"),
      }),
      (error: NodeJS.ErrnoException) => [
        "DURABLE_JSON_PARENT_UNSAFE",
        "DURABLE_JSON_TEMP_CLEANUP_FAILED",
      ].includes(String(error.code)),
    );
  } finally {
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
  }
  const preserved = JSON.parse(await readFile(path.join(moved, "leases", `${leaseId}.json`), "utf8"));
  assert.equal(preserved.heartbeatAt, "2026-01-01T00:00:00.000Z");
});

test("lock TTL validation rejects non-finite, non-positive, fractional, and oversized waits", async () => {
  const root = await tempRoot("cpb-lock-ttl-validation");
  const dataRoot = path.join(root, "runtime");
  for (const lockTtlMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 300_001, true, "10"]) {
    await assert.rejects(
      readLease(root, "lease-lock-ttl-validation", { dataRoot, lockTtlMs }),
      (error: NodeJS.ErrnoException) => error.code === "ELOCKTTLINVALID",
    );
  }
});

test("lease TTL validation runs before local or Redis state mutation", async () => {
  const root = await tempRoot("cpb-lease-ttl-validation");
  const dataRoot = path.join(root, "runtime");
  let backendCalls = 0;
  __infraLockTestHooks.redisLeaseBackend = () => {
    backendCalls += 1;
    return null;
  };
  try {
  for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        acquireLease(root, {
          dataRoot,
          leaseId: "lease-invalid-ttl",
          jobId: "job-invalid-ttl",
          phase: "execute",
          ttlMs,
        }),
        (error: NodeJS.ErrnoException) => error.code === "ELEASETTLINVALID",
      );
    }
  } finally {
    __infraLockTestHooks.redisLeaseBackend = undefined;
  }
  assert.equal(backendCalls, 0);
  await assert.rejects(access(leaseFile(dataRoot, "lease-invalid-ttl")));
});

test("lease acquisition rejects non-numeric owner PIDs before backend, filesystem, or identity capture", async () => {
  const root = await tempRoot("cpb-lease-owner-pid-validation");
  const dataRoot = path.join(root, "runtime");
  let backendCalls = 0;
  let captureCalls = 0;
  __infraLockTestHooks.redisLeaseBackend = () => {
    backendCalls += 1;
    return null;
  };
  __infraLockTestHooks.captureProcessIdentity = () => {
    captureCalls += 1;
    return null;
  };
  try {
    for (const ownerPid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "7001", true, null]) {
      await assert.rejects(
        acquireLease(root, {
          dataRoot,
          leaseId: "lease-invalid-owner-pid",
          jobId: "job-invalid-owner-pid",
          phase: "execute",
          ttlMs: 60_000,
          ownerPid: ownerPid as number,
        }),
        (error: NodeJS.ErrnoException) => error.code === "PROCESS_PID_INVALID",
      );
    }
  } finally {
    __infraLockTestHooks.redisLeaseBackend = undefined;
    __infraLockTestHooks.captureProcessIdentity = undefined;
  }
  assert.equal(backendCalls, 0);
  assert.equal(captureCalls, 0);
  await assert.rejects(access(dataRoot));
});

test("local lease renewal rejects an expired lease with Redis-compatible ESTALE", async () => {
  const root = await tempRoot("cpb-local-renew-expired");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-local-renew-expired";
  const file = await writeLease(dataRoot, leaseId, "expired-owner");
  const before = await readFile(file, "utf8");

  await assert.rejects(
    renewLease(root, leaseId, {
      dataRoot,
      ownerToken: "expired-owner",
      ttlMs: 60_000,
      now: new Date("2026-01-01T00:00:02.000Z"),
    }),
    (error: NodeJS.ErrnoException) => error.code === "ESTALE",
  );
  assert.equal(await readFile(file, "utf8"), before);
});

test("local lease parser requires its versioned exact schema and exact owner incarnation", async () => {
  const root = await tempRoot("cpb-lease-strict-schema");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-strict-schema";
  const file = await writeLease(dataRoot, leaseId);
  const valid = JSON.parse(await readFile(file, "utf8"));
  const invalidRecords = [
    { ...valid, formatVersion: undefined },
    { ...valid, formatVersion: LEASE_FORMAT_VERSION + 1 },
    { ...valid, ownerToken: undefined },
    { ...valid, ownerPid: String(valid.ownerPid) },
    { ...valid, ownerIdentity: { ...valid.ownerIdentity, birthIdPrecision: "coarse" } },
    { ...valid, ownerIdentity: { ...valid.ownerIdentity, injected: true } },
    { ...valid, injected: true },
    { ...valid, expiresAtMs: Date.parse(valid.expiresAt) + 1 },
  ];
  for (const invalid of invalidRecords) {
    await writeJson(file, invalid);
    await assert.rejects(
      readLease(root, leaseId, { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "ELEASEINVALID",
    );
  }
});

test("lease publication detects full leaf-directory generation changes", async () => {
  const root = await tempRoot("cpb-lease-directory-generation");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-directory-generation";
  const expectedFile = leaseFile(dataRoot, leaseId);
  __infraLockTestHooks.beforeJsonPublishRename = async ({ file }) => {
    if (file !== expectedFile) return;
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    const leasesRoot = path.dirname(file);
    await chmod(leasesRoot, 0o777);
    await chmod(leasesRoot, 0o755);
  };
  try {
    await assert.rejects(
      acquireLease(root, {
        dataRoot,
        leaseId,
        jobId: "job-directory-generation",
        phase: "execute",
        ttlMs: 60_000,
      }),
      (error: NodeJS.ErrnoException) => [
        "DURABLE_JSON_PARENT_UNSAFE",
        "DURABLE_JSON_TEMP_CLEANUP_FAILED",
      ].includes(String(error.code)),
    );
  } finally {
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
  }
  await assert.rejects(access(expectedFile));
});

test("lease removal reports lineage loss instead of a forged quarantine recovery path", async () => {
  const root = await tempRoot("cpb-lease-remove-lineage-loss");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-remove-lineage-loss";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-remove-lineage-loss",
    phase: "execute",
    ttlMs: 60_000,
  });
  let preserved = "";
  __infraLockTestHooks.afterDurableRemoveRename = async ({ quarantinePath }) => {
    __infraLockTestHooks.afterDurableRemoveRename = undefined;
    preserved = `${quarantinePath}.predecessor`;
    const record = JSON.parse(await readFile(quarantinePath, "utf8"));
    await rename(quarantinePath, preserved);
    await writeJson(quarantinePath, { ...record, jobId: "forged-quarantine" });
  };
  try {
    await assert.rejects(
      releaseLease(root, leaseId, { dataRoot, ownerToken: lease.ownerToken }),
      (error: NodeJS.ErrnoException & {
        committedPath?: unknown;
        quarantinePreserved?: unknown;
        lineageLost?: unknown;
        recoveryPaths?: { quarantine?: unknown };
      }) => {
        assert.equal(error.code, "DURABLE_REMOVE_LINEAGE_LOST");
        assert.equal(error.committedPath, null);
        assert.equal(error.quarantinePreserved, false);
        assert.equal(error.lineageLost, true);
        assert.equal(error.recoveryPaths?.quarantine, undefined);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.afterDurableRemoveRename = undefined;
  }
  assert.equal(JSON.parse(await readFile(preserved, "utf8")).jobId, "job-remove-lineage-loss");
});

test("lock isolation reports lineage loss when its quarantine name is replaced", async () => {
  const root = await tempRoot("cpb-lock-quarantine-lineage-loss");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-lock-quarantine-lineage-loss";
  await writeLease(dataRoot, leaseId);
  let preserved = "";
  __infraLockTestHooks.afterQuarantineRename = async ({ quarantineDir }) => {
    __infraLockTestHooks.afterQuarantineRename = undefined;
    preserved = `${quarantineDir}.predecessor`;
    await rename(quarantineDir, preserved);
    await mkdir(quarantineDir);
  };
  try {
    await assert.rejects(
      readLease(root, leaseId, { dataRoot }),
      (error: NodeJS.ErrnoException & {
        committedPath?: unknown;
        quarantinePreserved?: unknown;
        lineageLost?: unknown;
        recoveryPaths?: { quarantine?: unknown };
      }) => {
        assert.equal(error.code, "ELOCKLINEAGELOST");
        assert.equal(error.committedPath, null);
        assert.equal(error.quarantinePreserved, false);
        assert.equal(error.lineageLost, true);
        assert.equal(error.recoveryPaths?.quarantine, undefined);
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.afterQuarantineRename = undefined;
  }
  assert.match(preserved, /\.lock\.released\./);
  await access(preserved);
});

test("failed JSON temp isolation never reports a replacement as recoverable evidence", async () => {
  const root = await tempRoot("cpb-json-temp-lineage-loss");
  const dataRoot = path.join(root, "runtime");
  const leaseId = "lease-json-temp-lineage-loss";
  const lease = await acquireLease(root, {
    dataRoot,
    leaseId,
    jobId: "job-json-temp-lineage-loss",
    phase: "execute",
    ttlMs: 60_000,
  });
  const expectedFile = leaseFile(dataRoot, leaseId);
  let preserved = "";
  __infraLockTestHooks.beforeJsonPublishRename = async ({ file }) => {
    if (file !== expectedFile) return;
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    throw new Error("injected publication rejection");
  };
  __infraLockTestHooks.afterFailedJsonTempRename = async ({ quarantinePath }) => {
    __infraLockTestHooks.afterFailedJsonTempRename = undefined;
    preserved = `${quarantinePath}.predecessor`;
    await rename(quarantinePath, preserved);
    await writeFile(quarantinePath, "replacement", "utf8");
  };
  try {
    await assert.rejects(
      renewLease(root, leaseId, { dataRoot, ownerToken: lease.ownerToken, ttlMs: 60_000 }),
      (error: NodeJS.ErrnoException & { lineageLost?: unknown; recoveryPaths?: unknown }) => {
        assert.equal(error.code, "DURABLE_JSON_TEMP_LINEAGE_LOST");
        assert.equal(error.lineageLost, true);
        assert.deepEqual(error.recoveryPaths, {});
        return true;
      },
    );
  } finally {
    __infraLockTestHooks.beforeJsonPublishRename = undefined;
    __infraLockTestHooks.afterFailedJsonTempRename = undefined;
  }
  await access(preserved);
});
