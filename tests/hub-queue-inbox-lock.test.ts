import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  readInboxMessage,
  writeInboxMessage,
} from "../server/services/hub/hub-queue.js";
import { tempRoot } from "./helpers.js";

function inboxPaths(cpbRoot: string, project: string) {
  const inbox = path.join(cpbRoot, "wiki", "projects", project, "inbox");
  return { inbox, lockDir: `${inbox}.lock` };
}

function privateVarAlias(filePath: string) {
  if (filePath.startsWith("/private/var/")) return `/var/${filePath.slice("/private/var/".length)}`;
  if (filePath.startsWith("/var/")) return `/private/var/${filePath.slice("/var/".length)}`;
  return null;
}

test("hub inbox recovers an expired exact-owner lock before publishing", async (t) => {
  const cpbRoot = await tempRoot("cpb-hub-inbox-stale-lock");
  const project = "project-a";
  const { inbox, lockDir } = inboxPaths(cpbRoot, project);
  await mkdir(path.dirname(lockDir), { recursive: true });
  const canonicalLockPath = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const aliasLockPath = privateVarAlias(canonicalLockPath);
  if (!aliasLockPath) {
    t.skip("no /var and /private/var alias is available for this temp path");
    return;
  }
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
    format: "cpb-directory-lock/v1",
    ownerToken: "expired-owner",
    lockPath: aliasLockPath,
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "expired-owner-birth",
      incarnation: "999999:expired-owner-birth",
      capturedAt: new Date(0).toISOString(),
      birthIdPrecision: "exact",
    },
  }, null, 2)}\n`, "utf8");
  const expired = new Date(0);
  await utimes(lockDir, expired, expired);

  const published = await writeInboxMessage(cpbRoot, project, {
    type: "plan",
    content: "durable message",
  });

  assert.equal((await readInboxMessage(cpbRoot, project, published.id))?.content, "durable message\n");
  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
  assert.equal(path.dirname(path.join(inbox, `${published.id}.md`)), inbox);
});

test("hub inbox rejects a symbolic-link lock without touching its target", async () => {
  const cpbRoot = await tempRoot("cpb-hub-inbox-symlink-lock");
  const project = "project-b";
  const { lockDir } = inboxPaths(cpbRoot, project);
  const target = path.join(cpbRoot, "external-lock-target");
  await mkdir(path.dirname(lockDir), { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "sentinel.txt"), "preserve me", "utf8");
  await symlink(target, lockDir, "dir");

  await assert.rejects(
    writeInboxMessage(cpbRoot, project, { content: "must not publish" }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "DIRECTORY_LOCK_UNSAFE");
      return true;
    },
  );
  assert.equal(await readFile(path.join(target, "sentinel.txt"), "utf8"), "preserve me");
});
