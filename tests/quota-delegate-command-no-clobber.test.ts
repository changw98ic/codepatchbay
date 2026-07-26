import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { processQuotaDelegateInbox } from "../server/services/quota-delegate.js";
import {
  appendCommand,
  type QuotaDelegateClientPersistenceHooks,
  withQuotaDelegateClientPersistenceHooksForTests,
} from "../server/services/quota-delegate-client.js";
import { readProviderUsage } from "../server/services/provider-usage.js";

function inboxPath(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate", "inbox");
}

function ackPath(hubRoot: string, commandId: string) {
  return path.join(hubRoot, "providers", "delegate", "acks", `${commandId}.json`);
}

function commandPath(hubRoot: string, commandId: string) {
  return path.join(inboxPath(hubRoot), `${commandId}.json`);
}

async function makeHubRoot(t: test.TestContext) {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-no-clobber-"));
  t.after(async () => await rm(hubRoot, { recursive: true, force: true }));
  return hubRoot;
}

function usageCommand(commandId: string, phase: "execute" | "verify") {
  return {
    commandId,
    mutationId: commandId,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase,
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-07-21T00:00:00.000Z",
    },
  };
}

type ClientPersistenceHooks = QuotaDelegateClientPersistenceHooks;

type CommittedError = NodeJS.ErrnoException & {
  committed?: boolean;
  committedPath?: string;
  removalCommitted?: boolean;
  quarantinePreserved?: boolean;
  recoveryPaths?: string[];
  primaryError?: NodeJS.ErrnoException;
  cleanupErrors?: Error[];
};

test("same-id publication cannot replace an in-flight command before pathname removal", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "same-id-in-flight";
  const original = usageCommand(commandId, "execute");
  const replacement = usageCommand(commandId, "verify");
  let replacementError: NodeJS.ErrnoException | null = null;
  let replacementPublished = false;

  await appendCommand(hubRoot, original);
  await processQuotaDelegateInbox(hubRoot, {
    hooks: {
      beforeCommandRemoval: async ({ commandId: removingCommandId }) => {
        assert.equal(removingCommandId, commandId);
        try {
          await appendCommand(hubRoot, replacement);
          replacementPublished = true;
        } catch (error) {
          replacementError = error as NodeJS.ErrnoException;
        }
      },
    },
  });

  assert.equal(replacementPublished, false, "a live command pathname must never be overwritten");
  const conflict = replacementError as NodeJS.ErrnoException | null;
  assert.ok(conflict, "the replacement caller must receive an explicit conflict");
  assert.ok(
    conflict.code === "EEXIST"
      || conflict.code === "QUOTA_DELEGATE_COMMAND_ID_CONFLICT",
    `unexpected conflict code: ${conflict.code || "(missing)"}`,
  );

  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].mutationId, commandId);
  assert.equal(usage[0].phase, "execute");
  const ack = JSON.parse(await readFile(ackPath(hubRoot, commandId), "utf8"));
  assert.equal(ack.ok, true);
  assert.equal(ack.commandId, commandId);
  assert.equal(ack.mutationId, commandId);
  assert.deepEqual((await readdir(inboxPath(hubRoot))).filter((entry) => entry.endsWith(".json")), []);
  assert.deepEqual((await readdir(inboxPath(hubRoot))).filter((entry) => entry.includes(".tmp-")), []);
});

test("same-id replay after command removal uses the durable transaction instead of pathname overwrite", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "same-id-replay-after-removal";
  const command = usageCommand(commandId, "execute");

  await appendCommand(hubRoot, command);
  await processQuotaDelegateInbox(hubRoot);
  assert.equal((await readProviderUsage(hubRoot)).length, 1);

  await appendCommand(hubRoot, command);
  await processQuotaDelegateInbox(hubRoot);

  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].mutationId, commandId);
  const ack = JSON.parse(await readFile(ackPath(hubRoot, commandId), "utf8"));
  assert.equal(ack.ok, true);
  assert.equal(ack.commandId, commandId);
  assert.deepEqual((await readdir(inboxPath(hubRoot))).filter((entry) => entry.endsWith(".json")), []);
});

test("no-clobber publication reports committed temp-unlink durability ambiguity with exact recovery paths", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "published-temp-unlink-ambiguous";
  const expectedCommandPath = commandPath(hubRoot, commandId);
  const expectedInboxPath = inboxPath(hubRoot);
  let tempPath = "";
  let isolationPath = "";
  let thrown: CommittedError | null = null;

  try {
    await withQuotaDelegateClientPersistenceHooksForTests({
      beforeRename: ({ tempPath: observedTempPath }) => {
        tempPath = observedTempPath;
      },
      beforeTempIsolation: ({ isolationPath: observedIsolationPath }) => {
        isolationPath = observedIsolationPath;
      },
      syncDirectory: ({ phase }) => {
        if (phase === "temp-remove") {
          throw Object.assign(new Error("temp unlink directory fsync unsupported"), { code: "ENOTSUP" });
        }
      },
    } satisfies ClientPersistenceHooks, () => appendCommand(hubRoot, usageCommand(commandId, "execute")));
  } catch (error) {
    thrown = error as CommittedError;
  }

  assert.ok(thrown);
  assert.ok(tempPath);
  assert.ok(isolationPath);
  assert.equal(thrown.code, "QUOTA_DELEGATE_COMMAND_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal(thrown.committed, true);
  assert.equal(thrown.committedPath, expectedCommandPath);
  assert.deepEqual(
    new Set(thrown.recoveryPaths),
    new Set([expectedCommandPath, expectedInboxPath, tempPath, isolationPath]),
  );
  assert.ok(thrown.cleanupErrors?.some((error) => (
    error as NodeJS.ErrnoException
  ).code === "QUOTA_DELEGATE_TEMP_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS"));
  assert.equal(JSON.parse(await readFile(expectedCommandPath, "utf8")).commandId, commandId);
  await assert.rejects(readFile(tempPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(readFile(isolationPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("command removal reports quarantine-committed directory-sync ambiguity at the top level", async (t) => {
  const hubRoot = await makeHubRoot(t);
  const commandId = "command-removal-sync-ambiguous";
  const expectedCommandPath = commandPath(hubRoot, commandId);
  const expectedInboxPath = inboxPath(hubRoot);
  let thrown: CommittedError | null = null;

  await appendCommand(hubRoot, usageCommand(commandId, "execute"));
  try {
    await processQuotaDelegateInbox(hubRoot, {
      hooks: {
        syncCommandRemovalDirectory: () => {
          throw Object.assign(new Error("command removal directory fsync unsupported"), { code: "ENOTSUP" });
        },
      },
    } as unknown as Parameters<typeof processQuotaDelegateInbox>[1]);
  } catch (error) {
    thrown = error as CommittedError;
  }

  assert.ok(thrown);
  assert.equal(thrown.code, "QUOTA_DELEGATE_COMMAND_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal(thrown.committed, true);
  assert.equal(thrown.removalCommitted, false);
  assert.equal(thrown.quarantinePreserved, true);
  assert.ok(thrown.committedPath);
  const quarantinePath = thrown.committedPath;
  assert.equal(path.dirname(quarantinePath), expectedInboxPath);
  assert.match(path.basename(quarantinePath), /^\.command-removal-sync-ambiguous\.json\..+\.processed-recovery$/);
  assert.equal(thrown.primaryError?.code, "ENOTSUP");
  assert.deepEqual(
    new Set(thrown.recoveryPaths),
    new Set([expectedCommandPath, quarantinePath, expectedInboxPath]),
  );
  assert.equal(JSON.parse(await readFile(ackPath(hubRoot, commandId), "utf8")).ok, true);
  await assert.rejects(readFile(expectedCommandPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(JSON.parse(await readFile(quarantinePath, "utf8")).commandId, commandId);
});
