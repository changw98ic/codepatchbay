import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCommand,
  type QuotaDelegateClientPersistenceHooks,
  waitForAck,
  withQuotaDelegateClientPersistenceHooksForTests,
} from "../server/services/quota-delegate-client.js";

type TestPersistenceHooks = QuotaDelegateClientPersistenceHooks;

type DurabilityError = NodeJS.ErrnoException & {
  committed?: boolean;
  committedPath?: string;
  recoveryPaths?: string[];
  primaryError?: NodeJS.ErrnoException;
  cleanupErrors?: Error[];
};

async function withPersistenceHooks<T>(hooks: TestPersistenceHooks, operation: () => Promise<T>) {
  return withQuotaDelegateClientPersistenceHooksForTests(hooks, operation);
}

async function makeHubRoot(t: test.TestContext) {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-client-durability-"));
  t.after(async () => await rm(hubRoot, { recursive: true, force: true }));
  return hubRoot;
}

function ackPath(hubRoot: string, commandId: string) {
  return path.join(hubRoot, "providers", "delegate", "acks", `${commandId}.json`);
}

function inboxPath(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate", "inbox");
}

function commandPath(hubRoot: string, commandId: string) {
  return path.join(inboxPath(hubRoot), `${commandId}.json`);
}

function ackContent(hubRoot: string, commandId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    commandId,
    mutationId: commandId,
    hubRoot,
    ts: "2026-07-21T00:00:00.000Z",
    ok: true,
    ...extra,
  }) + "\n";
}

async function writeAck(hubRoot: string, commandId: string, extra: Record<string, unknown> = {}) {
  const filePath = ackPath(hubRoot, commandId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, ackContent(hubRoot, commandId, extra), "utf8");
  return filePath;
}

function ioError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

test("quota delegate client fails closed when O_NOFOLLOW is unavailable", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "no-follow-unavailable";
  await writeAck(hubRoot, commandId);

  await assert.rejects(
    withPersistenceHooks({ resolveNoFollowFlag: () => undefined }, () => waitForAck(hubRoot, commandId, 100)),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );
});

test("quota delegate client rejects acknowledgements larger than the bounded control-file limit", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "oversized-ack";
  await writeAck(hubRoot, commandId, { padding: "x".repeat(1024 * 1024) });

  await assert.rejects(
    waitForAck(hubRoot, commandId, 100),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );
});

test("quota delegate client rejects a path generation replaced between lstat and descriptor open", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "replace-before-open";
  const filePath = await writeAck(hubRoot, commandId);
  const replacementPath = `${filePath}.replacement`;
  const retiredPath = `${filePath}.retired`;
  await writeFile(replacementPath, await readFile(filePath), { mode: 0o600 });

  await assert.rejects(
    withPersistenceHooks({
      afterInitialLstat: async ({ filePath: observedPath }) => {
        assert.equal(observedPath, filePath);
        await rename(filePath, retiredPath);
        await rename(replacementPath, filePath);
      },
    }, () => waitForAck(hubRoot, commandId, 100)),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );
});

test("quota delegate client rejects descriptor metadata changes during a read", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "descriptor-generation-change";
  const filePath = await writeAck(hubRoot, commandId);
  const before = await stat(filePath);

  await assert.rejects(
    withPersistenceHooks({
      afterRead: async ({ filePath: observedPath }) => {
        assert.equal(observedPath, filePath);
        await utimes(filePath, new Date(1_000), new Date(2_000));
      },
    }, () => waitForAck(hubRoot, commandId, 100)),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );

  const after = await stat(filePath);
  assert.notEqual(after.mtimeMs, before.mtimeMs);
});

test("quota delegate client rejects a path generation replaced after descriptor read", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "replace-after-read";
  const filePath = await writeAck(hubRoot, commandId);
  const replacementPath = `${filePath}.replacement`;
  const retiredPath = `${filePath}.retired`;
  await writeFile(replacementPath, await readFile(filePath), { mode: 0o600 });

  await assert.rejects(
    withPersistenceHooks({
      beforePathGenerationCheck: async ({ filePath: observedPath }) => {
        assert.equal(observedPath, filePath);
        await rename(filePath, retiredPath);
        await rename(replacementPath, filePath);
      },
    }, () => waitForAck(hubRoot, commandId, 100)),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );
});

test("quota delegate client reports rename-committed directory-sync failures with recovery paths", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "publish-sync-unsupported";
  const expectedCommandPath = commandPath(hubRoot, commandId);
  const expectedInboxPath = inboxPath(hubRoot);
  let thrown: DurabilityError | null = null;

  try {
    await withPersistenceHooks({
      syncDirectory: ({ phase }) => {
        if (phase === "command-publish") throw ioError("directory fsync unsupported", "ENOTSUP");
      },
    }, () => appendCommand(hubRoot, {
      commandId,
      mutationId: commandId,
      type: "usage_write",
    }));
  } catch (error) {
    thrown = error as DurabilityError;
  }

  assert.ok(thrown);
  assert.equal(thrown.code, "QUOTA_DELEGATE_COMMAND_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal(thrown.committed, true);
  assert.equal(thrown.committedPath, expectedCommandPath);
  assert.equal(thrown.primaryError?.code, "ENOTSUP");
  assert.deepEqual(new Set(thrown.recoveryPaths), new Set([expectedCommandPath, expectedInboxPath]));
  assert.equal(JSON.parse(await readFile(expectedCommandPath, "utf8")).commandId, commandId);
});

test("quota delegate client preserves a pre-publication temporary generation for recovery", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "temp-unlink-sync-unsupported";
  const expectedInboxPath = inboxPath(hubRoot);
  let observedTempPath = "";
  let thrown: DurabilityError | null = null;

  try {
    await withPersistenceHooks({
      beforeRename: ({ tempPath }) => {
        observedTempPath = tempPath;
        throw ioError("stop before command publication", "EIO");
      },
    }, () => appendCommand(hubRoot, {
      commandId,
      mutationId: commandId,
      type: "usage_write",
    }));
  } catch (error) {
    thrown = error as DurabilityError;
  }

  assert.ok(thrown);
  assert.ok(observedTempPath);
  assert.equal(thrown.code, "QUOTA_DELEGATE_COMMAND_RECOVERY_REQUIRED");
  assert.equal(thrown.committed, false);
  assert.equal(thrown.primaryError?.code, "EIO");
  assert.deepEqual(
    new Set(thrown.recoveryPaths),
    new Set([observedTempPath, commandPath(hubRoot, commandId), expectedInboxPath]),
  );
  assert.equal(JSON.parse(await readFile(observedTempPath, "utf8")).commandId, commandId);
  await assert.rejects(readFile(commandPath(hubRoot, commandId), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("quota delegate client fails closed when strict directory descriptor flags are unavailable", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "directory-flags-unavailable";

  await assert.rejects(
    withPersistenceHooks({ resolveDirectoryFlags: () => undefined }, () => appendCommand(hubRoot, {
      commandId,
      mutationId: commandId,
      type: "usage_write",
    })),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_DIRECTORY_UNSAFE",
  );
  await assert.rejects(readFile(commandPath(hubRoot, commandId), "utf8"), { code: "ENOENT" });
});

test("quota delegate client rejects a symlinked acknowledgement directory", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const outside = await makeHubRoot(t);
  const commandId = "symlinked-ack-directory";
  const delegateRoot = path.join(hubRoot, "providers", "delegate");
  await mkdir(delegateRoot, { recursive: true });
  await writeFile(path.join(outside, `${commandId}.json`), ackContent(hubRoot, commandId), "utf8");
  await symlink(outside, path.join(delegateRoot, "acks"), "dir");

  await assert.rejects(
    waitForAck(hubRoot, commandId, 100),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_DIRECTORY_UNSAFE",
  );
});

test("quota delegate client preserves a same-path temporary successor during cleanup", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "temp-successor-preserved";
  const successor = "successor generation must remain\n";
  let tempPath = "";
  let predecessorPath = "";
  let thrown: DurabilityError | null = null;

  try {
    await withPersistenceHooks({
      beforeTempIsolation: async ({ tempPath: observedTempPath }) => {
        tempPath = observedTempPath;
        predecessorPath = `${observedTempPath}.predecessor`;
        await rename(observedTempPath, predecessorPath);
        await writeFile(observedTempPath, successor, { mode: 0o600 });
      },
    }, () => appendCommand(hubRoot, {
      commandId,
      mutationId: commandId,
      type: "usage_write",
    }));
  } catch (error) {
    thrown = error as DurabilityError;
  }

  assert.ok(thrown);
  assert.equal(thrown.code, "QUOTA_DELEGATE_COMMAND_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal(thrown.committed, true);
  assert.equal(thrown.committedPath, commandPath(hubRoot, commandId));
  assert.equal(await readFile(tempPath, "utf8"), successor);
  assert.equal(JSON.parse(await readFile(predecessorPath, "utf8")).commandId, commandId);
  assert.equal(JSON.parse(await readFile(commandPath(hubRoot, commandId), "utf8")).commandId, commandId);
  assert.ok(thrown.recoveryPaths?.includes(tempPath));
  assert.ok(thrown.cleanupErrors?.some((error) => (
    error as NodeJS.ErrnoException
  ).code === "QUOTA_DELEGATE_TEMP_SUCCESSOR_PRESERVED"));
});

test("quota delegate client preserves an isolated-path successor before final removal", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "isolated-successor-preserved";
  const successor = "isolated successor must remain\n";
  let isolationPath = "";
  let predecessorPath = "";
  let thrown: DurabilityError | null = null;

  try {
    await withPersistenceHooks({
      beforeTempRemoval: async ({ isolationPath: observedIsolationPath }) => {
        isolationPath = observedIsolationPath;
        predecessorPath = `${observedIsolationPath}.predecessor`;
        await rename(observedIsolationPath, predecessorPath);
        await writeFile(observedIsolationPath, successor, { mode: 0o600 });
      },
    }, () => appendCommand(hubRoot, {
      commandId,
      mutationId: commandId,
      type: "usage_write",
    }));
  } catch (error) {
    thrown = error as DurabilityError;
  }

  assert.ok(thrown);
  assert.equal(thrown.code, "QUOTA_DELEGATE_COMMAND_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal(thrown.committed, true);
  assert.equal(await readFile(isolationPath, "utf8"), successor);
  assert.equal(JSON.parse(await readFile(predecessorPath, "utf8")).commandId, commandId);
  assert.equal(JSON.parse(await readFile(commandPath(hubRoot, commandId), "utf8")).commandId, commandId);
  assert.ok(thrown.cleanupErrors?.some((error) => (
    error as NodeJS.ErrnoException
  ).code === "QUOTA_DELEGATE_TEMP_SUCCESSOR_PRESERVED"));
});

test("quota delegate client persistence hooks stay isolated across concurrent publications", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const blockedId = "scoped-hook-blocked";
  const normalId = "scoped-hook-normal";
  let releaseHook!: () => void;
  let hookStarted!: () => void;
  const hookReady = new Promise<void>((resolve) => { hookStarted = resolve; });
  const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });

  const blocked = withPersistenceHooks({
    beforeRename: async () => {
      hookStarted();
      await hookRelease;
      throw ioError("scoped publication failure", "EIO");
    },
  }, () => appendCommand(hubRoot, {
    commandId: blockedId,
    mutationId: blockedId,
    type: "usage_write",
  }));

  await hookReady;
  await appendCommand(hubRoot, {
    commandId: normalId,
    mutationId: normalId,
    type: "usage_write",
  });
  releaseHook();
  await assert.rejects(blocked, (error: NodeJS.ErrnoException) => (
    error.code === "QUOTA_DELEGATE_COMMAND_RECOVERY_REQUIRED"
  ));
  assert.equal(JSON.parse(await readFile(commandPath(hubRoot, normalId), "utf8")).commandId, normalId);
});
