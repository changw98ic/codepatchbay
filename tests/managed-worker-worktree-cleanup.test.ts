import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createWorktree } from "../runtime/git/worktree.js";
import {
  cleanupManagedWorkerWorktree,
  createIsolatedWorktreeWithRetry,
  parseManagedWorktreeDispositionProof,
  verifyRetainedManagedWorkerWorktree,
  WORKTREE_QUARANTINE_PREFIX,
  type ManagedWorktreeGitRunner,
  type VerifiedManagedWorktreeContext,
} from "../runtime/worker/worktree-manager.js";
import {
  publishTerminalResultAfterWorktreeCleanup,
  worktreeCleanupFailureEvidence,
  writeTerminalResultOnceVerified,
} from "../runtime/worker/managed-worker.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);
const gitIdentity = {
  GIT_AUTHOR_NAME: "CPB Test",
  GIT_AUTHOR_EMAIL: "cpb-test@local.invalid",
  GIT_COMMITTER_NAME: "CPB Test",
  GIT_COMMITTER_EMAIL: "cpb-test@local.invalid",
};

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...gitIdentity },
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(result.stdout);
}

async function gitRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; maxBuffer?: number },
) {
  return await execFileAsync(command, args, {
    cwd: opts.cwd,
    maxBuffer: opts.maxBuffer,
    env: { ...process.env, ...gitIdentity },
  });
}

async function absent(candidate: string) {
  await assert.rejects(access(candidate), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

async function directoryIdentity(candidate: string) {
  const info = await lstat(candidate, { bigint: true });
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

async function initializedFixture(name: string) {
  const root = await realpath(await tempRoot(`cpb-worktree-binding-${name}`));
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "source");
  await mkdir(hubRoot, { recursive: true });
  await git(root, ["init", "-b", "main", sourcePath]);
  await git(sourcePath, ["config", "user.name", "CPB Test"]);
  await git(sourcePath, ["config", "user.email", "cpb-test@local.invalid"]);
  await writeFile(path.join(sourcePath, "seed.txt"), "seed\n", "utf8");
  await git(sourcePath, ["add", "seed.txt"]);
  await git(sourcePath, ["commit", "-m", "seed"]);
  return {
    root,
    hubRoot,
    sourcePath,
    worktreesRoot: path.join(hubRoot, "worktrees"),
    worktreePath: path.join(hubRoot, "worktrees", "job-entry1-pipeline"),
    branch: "cpb/job-entry1-pipeline",
  };
}

async function fixture(name: string) {
  const paths = await initializedFixture(name);
  const managedWorktree = await createIsolatedWorktreeWithRetry({
    hubRoot: paths.hubRoot,
    sourcePath: paths.sourcePath,
    entryId: "entry1",
    maxAttempts: 1,
    retryDelayMs: 0,
    create: async (options) => await createWorktree({ ...options, codegraphEnabled: false }),
  });
  await writeFile(path.join(managedWorktree.path, "owned.txt"), "owned\n", "utf8");
  return { ...paths, managedWorktree };
}

function cleanupOptions(paths: Awaited<ReturnType<typeof fixture>>) {
  return {
    hubRoot: paths.hubRoot,
    sourcePath: paths.sourcePath,
    entryId: "entry1",
    managedWorktree: paths.managedWorktree,
  };
}

test("create independently verifies Git identity and cleanup quarantines that exact binding", async () => {
  const paths = await fixture("success");
  const calls: string[][] = [];
  const runGit: ManagedWorktreeGitRunner = async (command, args, opts) => {
    calls.push(args);
    return await gitRunner(command, args, opts);
  };
  const proof = await cleanupManagedWorkerWorktree({ ...cleanupOptions(paths), runGit });

  assert.equal(proof.disposition, "quarantined");
  assert.equal(proof.ok, true);
  assert.equal(proof.dispositionVerified, true);
  assert.equal(proof.canonicalPathRemoved, true);
  assert.equal(proof.gitMetadataRetained, true);
  assert.equal(proof.quarantinePreserved, true);
  assert.ok(proof.quarantineContainer);
  assert.ok(path.basename(proof.quarantineContainer!).startsWith(WORKTREE_QUARANTINE_PREFIX));
  assert.equal(proof.quarantinePath, path.join(proof.quarantineContainer!, "worktree"));
  assert.deepEqual(parseManagedWorktreeDispositionProof(proof, paths.managedWorktree), proof);
  await absent(paths.managedWorktree.path);
  assert.equal(await readFile(path.join(proof.quarantinePath!, "owned.txt"), "utf8"), "owned\n");
  assert.equal((await lstat(proof.quarantineContainer!)).mode & 0o077, 0);
  assert.equal(calls.some((args) => args.includes("remove") || args.includes("prune")), false);
});

test("plain-directory producer self-report is rejected and the unverified target is preserved", async () => {
  const paths = await initializedFixture("plain-producer");
  const baseCommit = (await git(paths.sourcePath, ["rev-parse", "HEAD"])).trim();

  await assert.rejects(
    createIsolatedWorktreeWithRetry({
      hubRoot: paths.hubRoot,
      sourcePath: paths.sourcePath,
      entryId: "entry1",
      maxAttempts: 1,
      retryDelayMs: 0,
      create: async () => {
        await mkdir(paths.worktreePath, { recursive: true });
        await writeFile(path.join(paths.worktreePath, "successor.txt"), "preserve\n", "utf8");
        return {
          path: paths.worktreePath,
          branch: paths.branch,
          baseBranch: "main",
          baseCommit,
          ownership: {
            version: 2,
            state: "ready",
            ownerToken: randomUUID(),
            baseBranch: "main",
            baseCommit,
            directory: await directoryIdentity(paths.worktreePath),
          },
        };
      },
    }),
    (error: Error & { code?: string; successorPreserved?: boolean }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_DEFERRED");
      assert.equal(error.successorPreserved, true);
      assert.match(error.message, /independently verified/i);
      return true;
    },
  );

  assert.equal(await readFile(path.join(paths.worktreePath, "successor.txt"), "utf8"), "preserve\n");
});

test("forged producer path is never touched", async () => {
  const paths = await initializedFixture("forged-path");
  const outside = path.join(paths.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "keep\n", "utf8");
  const baseCommit = (await git(paths.sourcePath, ["rev-parse", "HEAD"])).trim();

  await assert.rejects(
    createIsolatedWorktreeWithRetry({
      hubRoot: paths.hubRoot,
      sourcePath: paths.sourcePath,
      entryId: "entry1",
      maxAttempts: 1,
      retryDelayMs: 0,
      create: async () => ({
        path: outside,
        branch: paths.branch,
        baseBranch: "main",
        baseCommit,
        ownership: {
          version: 2,
          state: "ready",
          ownerToken: randomUUID(),
          baseBranch: "main",
          baseCommit,
          directory: await directoryIdentity(outside),
        },
      }),
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_DEFERRED");
      return true;
    },
  );
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep\n");
  await absent(paths.worktreePath);
});

test("cleanup rejects a create-to-cleanup directory successor", async () => {
  const paths = await fixture("target-successor");
  const predecessor = `${paths.managedWorktree.path}.predecessor`;
  await rename(paths.managedWorktree.path, predecessor);
  await mkdir(paths.managedWorktree.path);
  await writeFile(path.join(paths.managedWorktree.path, "successor.txt"), "successor\n", "utf8");

  await assert.rejects(
    cleanupManagedWorkerWorktree(cleanupOptions(paths)),
    (error: Error & { code?: string; successorPreserved?: boolean }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_BINDING_MISMATCH");
      assert.equal(error.successorPreserved, true);
      return true;
    },
  );
  assert.equal(await readFile(path.join(predecessor, "owned.txt"), "utf8"), "owned\n");
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "successor.txt"), "utf8"), "successor\n");
});

test("cleanup rejects a symlink successor without following it", async () => {
  const paths = await fixture("symlink-successor");
  const predecessor = `${paths.managedWorktree.path}.predecessor`;
  await rename(paths.managedWorktree.path, predecessor);
  await symlink(predecessor, paths.managedWorktree.path, "dir");

  await assert.rejects(
    cleanupManagedWorkerWorktree(cleanupOptions(paths)),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_TARGET_UNSAFE");
      return true;
    },
  );
  assert.equal((await lstat(paths.managedWorktree.path)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(predecessor, "owned.txt"), "utf8"), "owned\n");
});

test("cleanup rejects tampered durable branch ownership", async () => {
  const paths = await fixture("binding-tamper");
  const forged = {
    ...paths.managedWorktree.ownership,
    ownerToken: randomUUID(),
  };
  await git(paths.sourcePath, [
    "config",
    "--local",
    "--replace-all",
    `branch.${paths.branch}.cpbBaseBinding`,
    JSON.stringify(forged),
  ]);

  await assert.rejects(
    cleanupManagedWorkerWorktree(cleanupOptions(paths)),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_BINDING_MISMATCH");
      return true;
    },
  );
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
});

test("cleanup rejects detached HEAD and preserves the checkout", async () => {
  const paths = await fixture("detached-head");
  await git(paths.managedWorktree.path, ["checkout", "--detach"]);

  await assert.rejects(
    cleanupManagedWorkerWorktree(cleanupOptions(paths)),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_BINDING_MISMATCH");
      return true;
    },
  );
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
});

test("cleanup rejects a replaced source/common-dir authority", async () => {
  const paths = await fixture("source-successor");
  const predecessor = `${paths.sourcePath}.predecessor`;
  await rename(paths.sourcePath, predecessor);
  await mkdir(paths.sourcePath);
  await git(paths.root, ["init", "-b", "main", paths.sourcePath]);

  await assert.rejects(
    cleanupManagedWorkerWorktree(cleanupOptions(paths)),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_BINDING_MISMATCH");
      return true;
    },
  );
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
});

test("exclusive quarantine container refuses an occupied child without clobbering", async () => {
  const paths = await fixture("no-clobber");
  let attackerPath = "";

  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        beforeQuarantineRename: async ({ quarantinePath }) => {
          attackerPath = quarantinePath;
          await mkdir(quarantinePath);
          await writeFile(path.join(quarantinePath, "attacker.txt"), "attacker\n", "utf8");
        },
      },
    }),
    (error: Error & {
      code?: string;
      containerCommitted?: boolean;
      renameCommitted?: boolean;
      quarantinePreserved?: boolean;
      committedPath?: string;
      recoveryPaths?: Record<string, string>;
    }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_RECOVERY_REQUIRED");
      assert.equal(error.containerCommitted, true);
      assert.equal(error.renameCommitted, false);
      assert.equal(error.quarantinePreserved, false);
      assert.equal(error.committedPath, undefined);
      assert.equal(error.recoveryPaths?.quarantine, attackerPath);
      return true;
    },
  );
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
  assert.equal(await readFile(path.join(attackerPath, "attacker.txt"), "utf8"), "attacker\n");
});

test("post-rename hook error reports committed recovery truth", async () => {
  const paths = await fixture("post-rename-error");
  let quarantinePath = "";

  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        afterQuarantineRename: ({ quarantinePath: committedPath }) => {
          quarantinePath = committedPath;
          throw new Error("injected post-rename failure");
        },
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      committedPath?: string;
      quarantinePreserved?: boolean;
    }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_QUARANTINE_PRESERVED");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.quarantinePreserved, true);
      assert.equal(error.committedPath, quarantinePath);
      return true;
    },
  );
  await absent(paths.managedWorktree.path);
  assert.equal(await readFile(path.join(quarantinePath, "owned.txt"), "utf8"), "owned\n");
});

test("post-rename hook mutation is reobserved before recovery truth is reported", async () => {
  const paths = await fixture("post-rename-move-error");
  let quarantinePath = "";
  let movedPath = "";

  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        afterQuarantineRename: async ({ quarantinePath: committedPath }) => {
          quarantinePath = committedPath;
          movedPath = `${committedPath}.moved-by-hook`;
          await rename(committedPath, movedPath);
          throw new Error("injected post-rename move failure");
        },
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      committedPath?: string;
      quarantinePreserved?: boolean;
      recoveryPaths?: Record<string, string>;
    }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_RECOVERY_REQUIRED");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.quarantinePreserved, false);
      assert.equal(error.committedPath, undefined);
      assert.equal(error.recoveryPaths?.quarantine, quarantinePath);
      return true;
    },
  );
  await absent(paths.managedWorktree.path);
  await absent(quarantinePath);
  assert.equal(await readFile(path.join(movedPath, "owned.txt"), "utf8"), "owned\n");
});

test("post-rename authority close error cannot erase committed recovery truth", async () => {
  const paths = await fixture("post-rename-close-error");
  let injected = false;

  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        closeAuthority: async ({ label, close }) => {
          await close();
          if (!injected && label === "managed worktree quarantine container") {
            injected = true;
            throw new Error("injected authority close failure");
          }
        },
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      committedPath?: string;
      closeErrors?: unknown[];
    }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_QUARANTINE_PRESERVED");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.ok(error.committedPath);
      assert.equal(error.closeErrors?.length, 1);
      return true;
    },
  );
  assert.equal(injected, true);
  await absent(paths.managedWorktree.path);
});

test("authority close mutation is reobserved before recovery truth is reported", async () => {
  const paths = await fixture("post-rename-close-move-error");
  let quarantinePath = "";
  let movedPath = "";
  let injected = false;

  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        afterQuarantineRename: ({ quarantinePath: committedPath }) => {
          quarantinePath = committedPath;
        },
        closeAuthority: async ({ label, close }) => {
          await close();
          if (!injected && label === "managed worktree quarantine container") {
            injected = true;
            movedPath = `${quarantinePath}.moved-during-close`;
            await rename(quarantinePath, movedPath);
            throw new Error("injected authority close mutation failure");
          }
        },
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      committedPath?: string;
      quarantinePreserved?: boolean;
      closeErrors?: unknown[];
    }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_RECOVERY_REQUIRED");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.quarantinePreserved, false);
      assert.equal(error.committedPath, undefined);
      assert.equal(error.closeErrors?.length, 1);
      return true;
    },
  );
  assert.equal(injected, true);
  await absent(paths.managedWorktree.path);
  await absent(quarantinePath);
  assert.equal(await readFile(path.join(movedPath, "owned.txt"), "utf8"), "owned\n");
});

test("post-rename successor preserves both recovery generations", async () => {
  const paths = await fixture("post-rename-successor");
  let quarantinePath = "";

  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        afterQuarantineRename: async ({ quarantinePath: committedPath }) => {
          quarantinePath = committedPath;
          await mkdir(paths.managedWorktree.path);
          await writeFile(path.join(paths.managedWorktree.path, "successor.txt"), "successor\n", "utf8");
        },
      },
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      successorPreserved?: boolean;
    }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_QUARANTINE_PRESERVED");
      assert.equal(error.committed, true);
      assert.equal(error.successorPreserved, true);
      return true;
    },
  );
  assert.equal(await readFile(path.join(quarantinePath, "owned.txt"), "utf8"), "owned\n");
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "successor.txt"), "utf8"), "successor\n");
});

test("retention mode emits a strict verified disposition proof", async () => {
  const paths = await fixture("retained");
  const proof = await verifyRetainedManagedWorkerWorktree(cleanupOptions(paths));

  assert.equal(proof.disposition, "retained");
  assert.equal(proof.canonicalPathRemoved, false);
  assert.equal(proof.quarantineContainer, null);
  assert.equal(proof.quarantinePath, null);
  assert.equal(proof.reason, "product_validation_keep");
  assert.deepEqual(parseManagedWorktreeDispositionProof(proof, paths.managedWorktree), proof);
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
});

test("terminal success waits for an exact bound cleanup proof before publication", async () => {
  const paths = await fixture("terminal-cleanup");
  const order: string[] = [];
  let written: Record<string, unknown> | null = null;
  const resultPath = path.join(paths.root, "attempt", "result.json");

  const published = await publishTerminalResultAfterWorktreeCleanup({
    managedWorktree: paths.managedWorktree,
    expectedResultPath: resultPath,
    produceResult: async (capture) => {
      order.push("produce");
      await capture(resultPath, { status: "completed", cleanup: { codegraph: { ok: true } } });
      return { ok: true };
    },
    cleanupWorktree: async () => {
      order.push("cleanup");
      return await cleanupManagedWorkerWorktree(cleanupOptions(paths));
    },
    writeResult: async (_file, value) => {
      order.push("write");
      written = value as Record<string, unknown>;
      return true;
    },
    env: {},
  });

  assert.deepEqual(order, ["produce", "cleanup", "write"]);
  assert.equal(published.cleanupProof?.disposition, "quarantined");
  assert.deepEqual((written!.cleanup as Record<string, unknown>).worktree, published.cleanupProof);
});

test("terminal keep policy records verified retention instead of an unproved skip", async () => {
  const paths = await fixture("terminal-retention");
  const resultPath = path.join(paths.root, "attempt", "result.json");
  let written: Record<string, unknown> | null = null;

  const published = await publishTerminalResultAfterWorktreeCleanup({
    managedWorktree: paths.managedWorktree,
    expectedResultPath: resultPath,
    produceResult: async (capture) => {
      await capture(resultPath, { status: "completed" });
      return true;
    },
    retainWorktree: async () => await verifyRetainedManagedWorkerWorktree(cleanupOptions(paths)),
    writeResult: async (_file, value) => {
      written = value as Record<string, unknown>;
      return true;
    },
    env: { CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1" },
  });

  assert.equal(published.cleanupProof?.disposition, "retained");
  assert.deepEqual((written!.cleanup as Record<string, unknown>).worktree, published.cleanupProof);
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
});

test("terminal helper rejects arbitrary or wrong-policy proof before writing", async () => {
  const paths = await fixture("terminal-proof-reject");
  const resultPath = path.join(paths.root, "attempt", "result.json");
  let writes = 0;

  await assert.rejects(
    publishTerminalResultAfterWorktreeCleanup({
      managedWorktree: paths.managedWorktree,
      expectedResultPath: resultPath,
      produceResult: async (capture) => {
        await capture(resultPath, { status: "completed" });
        return true;
      },
      cleanupWorktree: async () => ({ ok: true }),
      writeResult: async () => {
        writes += 1;
        return true;
      },
      env: {},
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_PROOF_INVALID");
      return true;
    },
  );
  assert.equal(writes, 0);

  const retained = await verifyRetainedManagedWorkerWorktree(cleanupOptions(paths));
  const wrongBindingProof = {
    ...retained,
    binding: {
      ...retained.binding,
      verification: {
        ...retained.binding.verification,
        verifiedAt: new Date(Date.parse(retained.binding.verification.verifiedAt) + 1_000).toISOString(),
      },
    },
  };
  await assert.rejects(
    publishTerminalResultAfterWorktreeCleanup({
      managedWorktree: paths.managedWorktree,
      expectedResultPath: resultPath,
      produceResult: async (capture) => {
        await capture(resultPath, { status: "completed" });
        return true;
      },
      retainWorktree: async () => wrongBindingProof,
      writeResult: async () => {
        writes += 1;
        return true;
      },
      env: { CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1" },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_PROOF_INVALID");
      return true;
    },
  );
  assert.equal(writes, 0);
});

test("write-once false is accepted only for bounded nofollow exact idempotency", async () => {
  const root = await realpath(await tempRoot("cpb-terminal-idempotency"));
  const resultPath = path.join(root, "result.json");
  const value = { status: "failed", writtenAt: "2026-07-21T00:00:00.000Z" };
  await writeFile(resultPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  const idempotent = await writeTerminalResultOnceVerified({
    file: resultPath,
    value,
    writeResult: async () => false,
  });
  assert.equal(idempotent.created, false);
  assert.equal(idempotent.idempotent, true);

  await assert.rejects(
    writeTerminalResultOnceVerified({
      file: resultPath,
      value: { ...value, status: "completed" },
      writeResult: async () => false,
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "TERMINAL_RESULT_CONFLICT");
      return true;
    },
  );
});

test("terminal writer failure after cleanup retains final quarantine evidence", async () => {
  const paths = await fixture("terminal-writer-error");
  const resultPath = path.join(paths.root, "attempt", "result.json");
  let publicationFailure: unknown = null;

  await assert.rejects(
    publishTerminalResultAfterWorktreeCleanup({
      managedWorktree: paths.managedWorktree,
      expectedResultPath: resultPath,
      produceResult: async (capture) => {
        await capture(resultPath, { status: "completed" });
        return true;
      },
      cleanupWorktree: async () => await cleanupManagedWorkerWorktree(cleanupOptions(paths)),
      writeResult: async () => {
        throw Object.assign(new Error("injected terminal writer failure"), { code: "EIO" });
      },
      env: {},
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      quarantinePreserved?: boolean;
      committedPath?: string;
    }) => {
      publicationFailure = error;
      assert.equal(error.code, "WORKTREE_CLEANUP_QUARANTINE_PRESERVED");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.quarantinePreserved, true);
      assert.ok(error.committedPath);
      return true;
    },
  );

  const evidence = worktreeCleanupFailureEvidence(publicationFailure);
  assert.ok(evidence);
  assert.equal(evidence.committed, true);
  assert.equal(evidence.renameCommitted, true);
  assert.equal(evidence.quarantinePreserved, true);
  assert.equal(typeof evidence.committedPath, "string");
  await absent(paths.managedWorktree.path);
  assert.equal(await readFile(path.join(String(evidence.committedPath), "owned.txt"), "utf8"), "owned\n");
});

test("cleanup failure blocks success and preserves committed recovery evidence", async () => {
  const paths = await fixture("terminal-cleanup-error");
  const resultPath = path.join(paths.root, "attempt", "result.json");
  let writes = 0;
  let cleanupFailure: unknown = null;

  await assert.rejects(
    publishTerminalResultAfterWorktreeCleanup({
      managedWorktree: paths.managedWorktree,
      expectedResultPath: resultPath,
      produceResult: async (capture) => {
        await capture(resultPath, { status: "completed" });
        return true;
      },
      cleanupWorktree: async () => await cleanupManagedWorkerWorktree({
        ...cleanupOptions(paths),
        hooks: {
          afterQuarantineRename: () => {
            throw new Error("injected terminal cleanup failure");
          },
        },
      }).catch((error) => {
        cleanupFailure = error;
        throw error;
      }),
      writeResult: async () => {
        writes += 1;
        return true;
      },
      env: {},
    }),
  );

  assert.equal(writes, 0);
  assert.deepEqual(worktreeCleanupFailureEvidence(cleanupFailure), {
    code: "WORKTREE_CLEANUP_QUARANTINE_PRESERVED",
    committed: true,
    containerCommitted: true,
    renameCommitted: true,
    removalCommitted: false,
    quarantinePreserved: true,
    successorPreserved: false,
    committedPath: (cleanupFailure as { committedPath: string }).committedPath,
    recoveryPaths: (cleanupFailure as { recoveryPaths: Record<string, string> }).recoveryPaths,
  });
});

test("create waits on the same durable namespace fence held by cleanup", async () => {
  const paths = await fixture("writer-fence");
  let releaseCleanup!: () => void;
  let observedCleanup!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => { observedCleanup = resolve; });
  const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let createCalled = false;

  const cleanup = cleanupManagedWorkerWorktree({
    ...cleanupOptions(paths),
    hooks: {
      afterTargetObserved: async () => {
        observedCleanup();
        await cleanupRelease;
      },
    },
  });
  await cleanupEntered;
  const create = createIsolatedWorktreeWithRetry({
    hubRoot: paths.hubRoot,
    sourcePath: paths.sourcePath,
    entryId: "entry1",
    maxAttempts: 1,
    retryDelayMs: 0,
    create: async () => {
      createCalled = true;
      throw new Error("injected create failure");
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(createCalled, false);
  releaseCleanup();
  await cleanup;
  await assert.rejects(create, (error: Error & { code?: string }) => {
    assert.equal(error.code, "WORKTREE_CLEANUP_DEFERRED");
    return true;
  });
  assert.equal(createCalled, true);
});

test("quarantine container privacy check fails closed if its mode is widened", async () => {
  const paths = await fixture("container-mode");
  let container = "";
  await assert.rejects(
    cleanupManagedWorkerWorktree({
      ...cleanupOptions(paths),
      hooks: {
        beforeQuarantineRename: async ({ quarantineContainer }) => {
          container = quarantineContainer;
          await chmod(quarantineContainer, 0o755);
        },
      },
    }),
    (error: Error & { code?: string; renameCommitted?: boolean }) => {
      assert.equal(error.code, "WORKTREE_CLEANUP_RECOVERY_REQUIRED");
      assert.equal(error.renameCommitted, false);
      return true;
    },
  );
  assert.equal((await lstat(container)).mode & 0o077, 0o055);
  assert.equal(await readFile(path.join(paths.managedWorktree.path, "owned.txt"), "utf8"), "owned\n");
});
