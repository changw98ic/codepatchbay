import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openHubRedisStateBackend, redisRestoreCommitOutcome } from "../shared/hub-state-redis.js";
import { startHubServer } from "../server/index.js";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function configFixture(url: string, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-redis-state-unit-"));
  const configFile = path.join(root, "redis.json");
  await writeFile(configFile, `${JSON.stringify({
    format: "cpb-hub-state-redis/v1",
    url,
    registryKey: "cpb:{unit}:registry",
    connectTimeoutMs: 100,
    operationTimeoutMs: 100,
    ...overrides,
  })}\n`, { mode: 0o600 });
  await chmod(configFile, 0o600);
  return { root, hubRoot: path.join(root, "hub"), configFile };
}

test("Redis state parser rejects oversized declared replies without buffering the body", async (t) => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("$17825793\r\n"));
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  t.after(async () => {
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  await assert.rejects(backend.readRegistry(), { code: "HUB_STATE_BACKEND_UNAVAILABLE" });
});

test("Redis state backend bounds incomplete responses and hides upstream diagnostics", async (t) => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.write("-ERR sensitive-upstream-diagnostic\r\n"));
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://:super-secret@127.0.0.1:${port}/0`);
  t.after(async () => {
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  await assert.rejects(backend.preflight(), (error: unknown) => {
    const value = error as NodeJS.ErrnoException;
    assert.equal(value.code, "HUB_STATE_BACKEND_UNAVAILABLE");
    assert.doesNotMatch(value.message, /super-secret|sensitive-upstream-diagnostic/);
    return true;
  });
});

test("Redis state backend classifies a demoted primary without disclosing its reply", async (t) => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("-READONLY sensitive-provider-detail\r\n"));
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  t.after(async () => {
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  await assert.rejects(
    backend.compareAndSwapRegistry(0, 1, "{}"),
    (error: unknown) => {
      const value = error as NodeJS.ErrnoException;
      assert.equal(value.code, "HUB_STATE_BACKEND_NOT_PRIMARY");
      assert.equal(value.message, "Redis stable endpoint is not connected to a writable primary");
      assert.equal((value as NodeJS.ErrnoException & { commitOutcome?: string }).commitOutcome, undefined);
      assert.doesNotMatch(value.message, /sensitive-provider-detail/);
      return true;
    },
  );
});

test("Redis registry CAS marks a lost post-send response as an unknown commit outcome", async (t) => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end());
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  const mutationId = "registry-mutation-response-lost";
  t.after(async () => {
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  await assert.rejects(
    backend.compareAndSwapRegistry(0, 1, JSON.stringify({
      version: 1,
      revision: 1,
      projects: {},
      projectRevisions: {},
      mutationId,
    }), mutationId),
    (error: unknown) => {
      const value = error as NodeJS.ErrnoException & { commitOutcome?: string; mutationId?: string };
      assert.equal(value.code, "HUB_STATE_BACKEND_UNAVAILABLE");
      assert.equal(value.commitOutcome, "unknown");
      assert.equal(value.mutationId, mutationId);
      return true;
    },
  );
});

test("Redis logical restore preserves exact recovery evidence when the commit reply is lost", async (t) => {
  const token = "migration-restore-response-lost";
  const operation = "Hub local-to-Redis migration";
  const now = Date.now();
  const bulk = (value: string) => `$${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`;
  const array = (items: string[]) => `*${items.length}\r\n${items.join("")}`;
  const sockets = new Set<Socket>();
  let commandCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      commandCount += 1;
      if (commandCount === 1) {
        socket.write(array([
          bulk(token),
          bulk(operation),
          bulk(String(now - 1_000)),
          bulk(String(now + 60_000)),
          bulk(String(now)),
        ]));
      } else if (commandCount === 2) {
        socket.write(":1\r\n");
      } else if (commandCount === 3) {
        socket.write(array([
          bulk("0"),
          bulk(""),
          bulk(""),
          bulk(""),
          bulk(""),
          bulk(""),
          bulk(""),
          bulk(""),
          bulk(""),
          bulk(String(now)),
          ":0\r\n",
        ]));
      } else if (commandCount === 4) {
        socket.write(":1\r\n");
      } else if (commandCount === 5) {
        socket.write(":4\r\n");
      } else if (commandCount === 6) {
        socket.write(array([bulk("0"), "*0\r\n"]));
      } else if (commandCount === 7) {
        socket.end();
      } else {
        socket.write(":1\r\n");
      }
    });
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`, { operationTimeoutMs: 1_000 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const snapshotBody = {
    format: "cpb-hub-redis-logical-snapshot/v1" as const,
    backendIdentityFingerprint: backend.identityFingerprint,
    capturedAt: new Date(now).toISOString(),
    hashFields: [] as Array<[string, string]>,
    jobStreams: [] as Array<{ field: string; events: string[] }>,
  };
  const snapshot = {
    ...snapshotBody,
    sha256: createHash("sha256").update(JSON.stringify(snapshotBody), "utf8").digest("hex"),
  };
  const expectedEvidence = {
    registryKey: backend.registryKey,
    backendIdentityFingerprint: backend.identityFingerprint,
    snapshotSha256: snapshot.sha256,
    operationToken: token,
  };
  let replyLossError: unknown;

  await assert.rejects(
    backend.restoreSnapshot(token, snapshot),
    (error: unknown) => {
      replyLossError = error;
      const value = error as NodeJS.ErrnoException & {
        commitOutcome?: unknown;
        commitMayHaveOccurred?: unknown;
        redisCommitRecovery?: Record<string, unknown>;
      };
      assert.equal(value.code, "HUB_STATE_BACKEND_UNAVAILABLE");
      assert.equal(value.commitOutcome, "unknown");
      assert.equal(value.commitMayHaveOccurred, true);
      assert.equal(redisRestoreCommitOutcome(error, expectedEvidence), "unknown");
      assert.equal(redisRestoreCommitOutcome(error, { ...expectedEvidence, registryKey: "cpb:{other}:registry" }), null);
      assert.deepEqual(value.redisCommitRecovery, {
        registryKey: backend.registryKey,
        stageRegistryKey: value.redisCommitRecovery?.stageRegistryKey,
        stageStreamKeys: [],
        backendIdentityFingerprint: backend.identityFingerprint,
        snapshotSha256: snapshot.sha256,
      });
      assert.match(String(value.redisCommitRecovery?.stageRegistryKey), /^cpb:\{unit\}:restore:[a-f0-9]{24}:registry$/);
      return true;
    },
  );
  assert.equal(
    redisRestoreCommitOutcome(replyLossError, {
      ...expectedEvidence,
      operationToken: "migration-later-attempt",
    }),
    null,
    "a reply-loss error from an earlier migration must not be trusted by a later operation",
  );
  assert.equal(commandCount, 7, "unknown commit outcome must not trigger destructive staging cleanup");
});

test("Redis state parser enforces a global response-node budget", async (t) => {
  const nested = `*9\r\n${Array.from({ length: 9 }, () => `*1024\r\n${":1\r\n".repeat(1024)}`).join("")}`;
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(nested));
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  t.after(async () => {
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  await assert.rejects(backend.readRegistry(), { code: "HUB_STATE_BACKEND_UNAVAILABLE" });
});

test("Redis state backend reuses a bounded connection for sequential commands", async (t) => {
  let connectionCount = 0;
  let commandCount = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      commandCount += 1;
      socket.write("*2\r\n$-1\r\n$-1\r\n");
    });
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  assert.equal(await backend.readRegistry(), null);
  assert.equal(await backend.readRegistry(), null);
  assert.equal(commandCount, 2);
  assert.equal(connectionCount, 1);
});

test("Redis state backend bounds concurrent connections", async (t) => {
  let connectionCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        socket.write("*2\r\n$-1\r\n$-1\r\n");
      }, 10);
    });
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`, { operationTimeoutMs: 1_000 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const results = await Promise.all(Array.from({ length: 24 }, () => backend.readRegistry()));
  assert.ok(results.every((value) => value === null));
  assert.ok(connectionCount > 1);
  assert.ok(connectionCount <= 8, `opened ${connectionCount} connections`);
  assert.ok(maxInFlight <= 8, `ran ${maxInFlight} commands concurrently`);
});

test("Redis state backend idle connections do not keep a CLI process alive", async (t) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => socket.write("*2\r\n$-1\r\n$-1\r\n"));
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`, { operationTimeoutMs: 1_000 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });

  const moduleUrl = new URL("../shared/hub-state-redis.js", import.meta.url).href;
  const script = [
    `const { openHubRedisStateBackend } = await import(${JSON.stringify(moduleUrl)});`,
    `const backend = await openHubRedisStateBackend({ configFile: ${JSON.stringify(fixture.configFile)}, hubRoot: ${JSON.stringify(fixture.hubRoot)} });`,
    "await backend.readRegistry();",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child process remained alive with an idle Redis connection"));
    // This bound includes Node startup and module loading in addition to the
    // behavior under test (the idle socket must be unref'd). Keep it finite,
    // but leave enough headroom for loaded CI hosts.
    }, 5_000);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  });
  const result = await Promise.race([exit, timeout]);
  assert.deepEqual(result, { code: 0, signal: null }, Buffer.concat(stderr).toString("utf8"));
});

test("Redis state backend discards a broken pooled connection without replaying a command", async (t) => {
  let connectionCount = 0;
  let commandCount = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      commandCount += 1;
      if (commandCount === 2) {
        socket.destroy();
        return;
      }
      socket.write("*2\r\n$-1\r\n$-1\r\n");
    });
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });

  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  assert.equal(await backend.readRegistry(), null);
  await assert.rejects(backend.readRegistry(), { code: "HUB_STATE_BACKEND_UNAVAILABLE" });
  assert.equal(commandCount, 2, "failed command must not be replayed automatically");
  assert.equal(await backend.readRegistry(), null);
  assert.equal(connectionCount, 2);
  assert.equal(commandCount, 3);
});

test("Redis state record scans request a response-bounded batch", async (t) => {
  let command = "";
  const sockets = new Set<Socket>();
  const envelope = JSON.stringify({ revision: 1, data: { workerId: "worker-1" } });
  const response = `*2\r\n$1\r\n0\r\n*2\r\n$15\r\nworker:worker-1\r\n$${Buffer.byteLength(envelope)}\r\n${envelope}\r\n`;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      command += chunk.toString("utf8");
      socket.write(response);
    });
  });
  const port = await listen(server);
  const fixture = await configFixture(`redis://127.0.0.1:${port}/0`);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await rm(fixture.root, { recursive: true, force: true });
  });

  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const records = await backend.scanStateRecords("worker:");
  assert.equal(records.length, 1);
  assert.match(command, /\$5\r\nCOUNT\r\n\$1\r\n4\r\n/);
});

test("Redis state config rejects remote cleartext, in-root files, symlinks, unknown fields, and unsupported topologies", async (t) => {
  const remote = await configFixture("redis://redis.example.test:6379/0");
  const inRoot = await configFixture("redis://127.0.0.1:6379/0");
  const unknown = await configFixture("redis://127.0.0.1:6379/0", { unexpected: true });
  const unsupportedTopology = await configFixture("redis://127.0.0.1:6379/0", { topology: "sentinel" });
  const linkPath = path.join(remote.root, "redis-link.json");
  await symlink(remote.configFile, linkPath);
  const aliasedHubRoot = path.join(remote.root, "aliased-hub");
  await mkdir(aliasedHubRoot);
  const inHubConfig = path.join(aliasedHubRoot, "redis.json");
  await writeFile(inHubConfig, await readFile(remote.configFile), { mode: 0o600 });
  const ancestorAlias = path.join(remote.root, "outside-alias");
  await symlink(aliasedHubRoot, ancestorAlias, "dir");
  const hardlink = await configFixture("redis://127.0.0.1:6379/0");
  await mkdir(hardlink.hubRoot);
  await link(hardlink.configFile, path.join(hardlink.hubRoot, "redis-hardlink.json"));
  t.after(async () => {
    await Promise.all([remote, inRoot, unknown, unsupportedTopology, hardlink]
      .map((fixture) => rm(fixture.root, { recursive: true, force: true })));
  });

  await assert.rejects(
    openHubRedisStateBackend({ configFile: remote.configFile, hubRoot: remote.hubRoot }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
  await assert.rejects(
    openHubRedisStateBackend({ configFile: inRoot.configFile, hubRoot: inRoot.root }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
  await assert.rejects(
    openHubRedisStateBackend({ configFile: linkPath, hubRoot: remote.hubRoot }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
  await assert.rejects(
    openHubRedisStateBackend({ configFile: path.join(ancestorAlias, "redis.json"), hubRoot: aliasedHubRoot }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
  await assert.rejects(
    openHubRedisStateBackend({ configFile: unknown.configFile, hubRoot: unknown.hubRoot }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
  await assert.rejects(
    openHubRedisStateBackend({ configFile: unsupportedTopology.configFile, hubRoot: unsupportedTopology.hubRoot }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
  await assert.rejects(
    openHubRedisStateBackend({ configFile: hardlink.configFile, hubRoot: hardlink.hubRoot }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );
});

test("Hub startup fails closed when the configured Redis backend is unavailable", async (t) => {
  const fixture = await configFixture("redis://:do-not-disclose@127.0.0.1:1/0");
  const previous = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = fixture.configFile;
  t.after(async () => {
    if (previous === undefined) delete process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
    else process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE = previous;
    await rm(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    startHubServer({ cpbRoot: fixture.root, hubRoot: fixture.hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true }),
    (error: unknown) => {
      const value = error as NodeJS.ErrnoException;
      assert.equal(value.code, "HUB_STATE_BACKEND_UNAVAILABLE");
      assert.doesNotMatch(value.message, /do-not-disclose/);
      return true;
    },
  );
});
