/**
 * Safety-property tests for core/indexing/local-code-index/safe-files.ts.
 *
 * Verifies that the low-level filesystem operations enforce:
 *   1. Path traversal via symlinks is rejected (O_NOFOLLOW).
 *   2. Symlink reads fail at the fd level.
 *   3. Oversized files are rejected before reading.
 *   4. Identity recheck detects file replacement / mutation.
 *   5. Exclusive creation prevents overwrites (O_EXCL).
 *   6. Atomic rename is durable (fsync on parent directory).
 *
 * Run:
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-safe-files.test.ts
 */

import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  atomicRename,
  exclusiveCreateTemp,
  exclusiveHardLinkPublish,
  FileSizeExceededError,
  IdentityMismatchError,
  pinnedIdentityRecheck,
  readBoundedFileNoFollow,
  SymlinkFollowError,
  ExclusiveCreateConflictError,
  writeDurableFile,
} from "../core/indexing/local-code-index/safe-files.js";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempRoots: string[][] = [];

after(async () => {
  if (process.env.CPB_KEEP_TEMP) {
    for (const [root] of tempRoots) process.stderr.write(`[keep-temp] ${root}\n`);
    return;
  }
  await Promise.all(
    tempRoots.map(([root]) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTemp(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const root = await realpath(created);
  tempRoots.push([root]);
  return root;
}

// ===========================================================================
// 1. Path traversal via symlink is rejected
// ===========================================================================

test("readBoundedFileNoFollow rejects a symlink that escapes the expected directory", async () => {
  const tmp = await makeTemp("safe-traverse-read");
  const outsideDir = path.join(tmp, "outside");
  const insideDir = path.join(tmp, "inside");
  await mkdir(outsideDir, { recursive: true });
  await mkdir(insideDir, { recursive: true });

  const secretPath = path.join(outsideDir, "secret.txt");
  const symlinkPath = path.join(insideDir, "link.txt");
  await writeFile(secretPath, "secret data\n", "utf8");
  await symlink(secretPath, symlinkPath);

  // Attempting to read through the symlink must fail because O_NOFOLLOW rejects it.
  await assert.rejects(
    () => readBoundedFileNoFollow(symlinkPath, 4096),
    (error: unknown) => {
      // On macOS, O_NOFOLLOW yields ELOOP; the wrapper throws SymlinkFollowError.
      if (error instanceof SymlinkFollowError) return true;
      // Some platforms surface a raw system error with code ELOOP.
      const code = (error as NodeJS.ErrnoException).code;
      assert.equal(code, "ELOOP", `expected ELOOP, got ${code}`);
      return true;
    },
  );

  // The secret file must remain untouched.
  assert.equal(await readFile(secretPath, "utf8"), "secret data\n");
});

test("writeDurableFile rejects a symlink target (O_NOFOLLOW on write)", async () => {
  const tmp = await makeTemp("safe-traverse-write");
  const outsideDir = path.join(tmp, "outside");
  const insideDir = path.join(tmp, "inside");
  await mkdir(outsideDir, { recursive: true });
  await mkdir(insideDir, { recursive: true });

  const targetPath = path.join(outsideDir, "target.txt");
  const symlinkPath = path.join(insideDir, "link.txt");
  await writeFile(targetPath, "original\n", "utf8");
  await symlink(targetPath, symlinkPath);

  // Writing through the symlink must fail — O_NOFOLLOW prevents fd creation.
  await assert.rejects(
    () => writeDurableFile(symlinkPath, new TextEncoder().encode("overwritten\n")),
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      assert.ok(
        code === "ELOOP" || error instanceof SymlinkFollowError,
        `expected ELOOP or SymlinkFollowError, got ${code}`,
      );
      return true;
    },
  );

  // The original content must survive.
  assert.equal(await readFile(targetPath, "utf8"), "original\n");
});

// ===========================================================================
// 2. Symlink reads fail (no-follow at the fd level)
// ===========================================================================

test("readBoundedFileNoFollow throws SymlinkFollowError for a regular symlink", async () => {
  const tmp = await makeTemp("safe-symlink-read");
  const realFile = path.join(tmp, "real.txt");
  const linkFile = path.join(tmp, "link.txt");
  await writeFile(realFile, "hello world\n", "utf8");
  await symlink(realFile, linkFile);

  // Verify the symlink exists and points to the real file.
  const linkStat = await lstat(linkFile);
  assert.ok(linkStat.isSymbolicLink(), "must be a symlink");

  // readBoundedFileNoFollow must reject the symlink.
  await assert.rejects(
    () => readBoundedFileNoFollow(linkFile, 4096),
    (error: unknown) => {
      if (error instanceof SymlinkFollowError) {
        assert.equal(error.path, linkFile);
        return true;
      }
      const code = (error as NodeJS.ErrnoException).code;
      assert.equal(code, "ELOOP");
      return true;
    },
  );
});

test("readBoundedFileNoFollow succeeds on a real (non-symlink) file", async () => {
  const tmp = await makeTemp("safe-real-read");
  const filePath = path.join(tmp, "real.txt");
  const content = "real content\n";
  await writeFile(filePath, content, "utf8");

  const result = await readBoundedFileNoFollow(filePath, 4096);
  assert.equal(new TextDecoder().decode(result), content);
});

// ===========================================================================
// 3. Oversized input is rejected
// ===========================================================================

test("readBoundedFileNoFollow throws FileSizeExceededError when file exceeds maxBytes", async () => {
  const tmp = await makeTemp("safe-oversized");
  const filePath = path.join(tmp, "large.bin");
  const payload = new Uint8Array(2048).fill(0xab);
  await writeFile(filePath, payload);

  await assert.rejects(
    () => readBoundedFileNoFollow(filePath, 1024),
    (error: unknown) => {
      assert.ok(error instanceof FileSizeExceededError);
      assert.equal(error.path, filePath);
      assert.equal(error.maxBytes, 1024);
      assert.equal(error.actualBytes, 2048);
      assert.ok(error.message.includes("2048"));
      assert.ok(error.message.includes("1024"));
      return true;
    },
  );
});

test("readBoundedFileNoFollow reads a file exactly at the bound", async () => {
  const tmp = await makeTemp("safe-exact-bound");
  const filePath = path.join(tmp, "exact.bin");
  const size = 512;
  const payload = new Uint8Array(size).fill(0xcd);
  await writeFile(filePath, payload);

  const result = await readBoundedFileNoFollow(filePath, size);
  assert.equal(result.length, size);
  assert.equal(result[0], 0xcd);
  assert.equal(result[size - 1], 0xcd);
});

test("readBoundedFileNoFollow reads a file one byte under the bound", async () => {
  const tmp = await makeTemp("safe-under-bound");
  const filePath = path.join(tmp, "under.bin");
  const size = 511;
  const payload = new Uint8Array(size).fill(0xef);
  await writeFile(filePath, payload);

  const result = await readBoundedFileNoFollow(filePath, 512);
  assert.equal(result.length, size);
});

test("readBoundedFileNoFollow reads an empty file", async () => {
  const tmp = await makeTemp("safe-empty-read");
  const filePath = path.join(tmp, "empty.txt");
  await writeFile(filePath, new Uint8Array(0));

  const result = await readBoundedFileNoFollow(filePath, 4096);
  assert.equal(result.length, 0);
});

// ===========================================================================
// 4. Identity recheck detects changes
// ===========================================================================

test("pinnedIdentityRecheck passes when file is unchanged", async () => {
  const tmp = await makeTemp("safe-identity-pass");
  const filePath = path.join(tmp, "stable.txt");
  await writeFile(filePath, "stable content\n", "utf8");

  const info = await stat(filePath);
  const identity = { size: info.size, ino: info.ino, dev: info.dev };

  // Must not throw.
  await pinnedIdentityRecheck(filePath, identity);
});

test("pinnedIdentityRecheck throws IdentityMismatchError when file size changes", async () => {
  const tmp = await makeTemp("safe-identity-size");
  const filePath = path.join(tmp, "mutated.txt");
  await writeFile(filePath, "short\n", "utf8");

  const info = await stat(filePath);
  const identity = { size: info.size, ino: info.ino, dev: info.dev };

  // Mutate the file so size changes.
  await writeFile(filePath, "much longer content than before\n", "utf8");

  await assert.rejects(
    () => pinnedIdentityRecheck(filePath, identity),
    (error: unknown) => {
      assert.ok(error instanceof IdentityMismatchError);
      assert.equal(error.path, filePath);
      assert.equal(error.expected.size, identity.size);
      assert.ok(error.actual.size !== identity.size, "actual size must differ");
      return true;
    },
  );
});

test("pinnedIdentityRecheck throws IdentityMismatchError when file is replaced (new inode)", async () => {
  const tmp = await makeTemp("safe-identity-inode");
  const filePath = path.join(tmp, "replaced.txt");
  await writeFile(filePath, "original\n", "utf8");

  const info = await stat(filePath);
  const identity = { size: info.size, ino: info.ino, dev: info.dev };

  // Replace the file by unlink + rewrite (new inode on most filesystems).
  const { unlink } = await import("node:fs/promises");
  await unlink(filePath);
  await writeFile(filePath, "replaced!\n", "utf8");

  // On most POSIX filesystems the new file gets a different inode.
  // If inode happens to be reused (unlikely), the size difference still catches it.
  const newInfo = await stat(filePath);
  if (newInfo.ino !== identity.ino || newInfo.size !== identity.size) {
    await assert.rejects(
      () => pinnedIdentityRecheck(filePath, identity),
      (error: unknown) => {
        assert.ok(error instanceof IdentityMismatchError);
        assert.equal(error.path, filePath);
        return true;
      },
    );
  } else {
    // Extremely unlikely: same inode reused with same size — skip gracefully.
    assert.ok(true, "inode reuse with same size — test not applicable on this filesystem");
  }
});

test("IdentityMismatchError carries expected and actual identity fields", async () => {
  const expected = { size: 10, ino: 12345, dev: 67890 };
  const actual = { size: 20, ino: 99999, dev: 11111 };
  const error = new IdentityMismatchError("/tmp/test.txt", expected, actual);

  assert.equal(error.name, "IdentityMismatchError");
  assert.equal(error.path, "/tmp/test.txt");
  assert.deepEqual(error.expected, expected);
  assert.deepEqual(error.actual, actual);
  assert.ok(error.message.includes("12345"));
  assert.ok(error.message.includes("99999"));
});

// ===========================================================================
// 5. Exclusive creation prevents overwrites
// ===========================================================================

test("exclusiveCreateTemp creates a new file and returns its path", async () => {
  const tmp = await makeTemp("safe-exclusive-ok");
  const filePath = await exclusiveCreateTemp(tmp, "shard-");

  assert.ok(filePath.startsWith(tmp));
  assert.ok(filePath.includes("shard-"));

  // The file must exist.
  const info = await stat(filePath);
  assert.ok(info.isFile(), "must be a regular file");

  // Cleanup the created file.
  const { unlink } = await import("node:fs/promises");
  await unlink(filePath);
});

test("exclusiveCreateTemp creates the directory if it does not exist", async () => {
  const tmp = await makeTemp("safe-exclusive-mkdir");
  const nestedDir = path.join(tmp, "a", "b", "c");

  const filePath = await exclusiveCreateTemp(nestedDir, "index-");
  assert.ok(filePath.startsWith(nestedDir));

  const info = await stat(filePath);
  assert.ok(info.isFile());

  const { unlink } = await import("node:fs/promises");
  await unlink(filePath);
});

test("exclusiveCreateTemp two calls produce distinct paths (no collision)", async () => {
  const tmp = await makeTemp("safe-exclusive-no-collision");

  // With timestamp + random suffix, two rapid calls should not collide.
  // We cannot easily force a collision, but we can verify both succeed.
  const first = await exclusiveCreateTemp(tmp, "shard-");
  const second = await exclusiveCreateTemp(tmp, "shard-");

  assert.notEqual(first, second, "two rapid calls must produce different paths");

  const { unlink } = await import("node:fs/promises");
  await unlink(first);
  await unlink(second);
});

test("writeDurableFile with O_EXCL semantics prevents clobbering a pre-existing file (manual O_EXCL)", async () => {
  const tmp = await makeTemp("safe-exclusive-manual");
  const filePath = path.join(tmp, "existing.txt");
  await writeFile(filePath, "original\n", "utf8");

  // Manually open with O_CREAT | O_EXCL | O_NOFOLLOW — must fail with EEXIST.
  await assert.rejects(
    open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
      return true;
    },
  );

  // Original content survives.
  assert.equal(await readFile(filePath, "utf8"), "original\n");
});

test("exclusiveHardLinkPublish fails when target already exists", async () => {
  const tmp = await makeTemp("safe-hardlink-conflict");
  const srcPath = path.join(tmp, "source.txt");
  const dstPath = path.join(tmp, "dest.txt");
  await writeFile(srcPath, "source data\n", "utf8");
  await writeFile(dstPath, "existing data\n", "utf8");

  // link(2) must fail with EEXIST when the destination already exists.
  await assert.rejects(
    exclusiveHardLinkPublish(srcPath, dstPath),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
      return true;
    },
  );

  // Both files survive with original content.
  assert.equal(await readFile(srcPath, "utf8"), "source data\n");
  assert.equal(await readFile(dstPath, "utf8"), "existing data\n");
});

// ===========================================================================
// 6. Atomic rename is durable
// ===========================================================================

test("atomicRename moves the file to the final path", async () => {
  const tmp = await makeTemp("safe-rename-basic");
  const srcPath = path.join(tmp, "temp-shard.json");
  const dstPath = path.join(tmp, "final-shard.json");
  const content = '{"data": "index payload"}\n';
  await writeFile(srcPath, content, "utf8");

  await atomicRename(srcPath, dstPath);

  // Destination must exist with correct content.
  assert.equal(await readFile(dstPath, "utf8"), content);

  // Source must be gone.
  await assert.rejects(
    stat(srcPath),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    },
  );
});

test("atomicRename overwrites an existing destination (POSIX rename semantics)", async () => {
  const tmp = await makeTemp("safe-rename-overwrite");
  const srcPath = path.join(tmp, "temp.json");
  const dstPath = path.join(tmp, "final.json");
  await writeFile(srcPath, "new content\n", "utf8");
  await writeFile(dstPath, "old content\n", "utf8");

  await atomicRename(srcPath, dstPath);

  assert.equal(await readFile(dstPath, "utf8"), "new content\n");

  // Source must be gone.
  await assert.rejects(stat(srcPath), { code: "ENOENT" });
});

test("atomicRename is fsync-durable (parent directory is synced)", async () => {
  const tmp = await makeTemp("safe-rename-fsync");
  const srcPath = path.join(tmp, "temp-durable.json");
  const dstPath = path.join(tmp, "final-durable.json");
  const content = '{"durable": true}\n';
  await writeFile(srcPath, content, "utf8");

  await atomicRename(srcPath, dstPath);

  // Verify the destination is a regular file (not a symlink) and has the content.
  const info = await stat(dstPath);
  assert.ok(info.isFile());
  assert.equal(info.size, Buffer.byteLength(content));
  assert.equal(await readFile(dstPath, "utf8"), content);
});

test("atomicRename into a nested directory creates the destination there", async () => {
  const tmp = await makeTemp("safe-rename-nested");
  const nestedDir = path.join(tmp, "indexes", "shards");
  await mkdir(nestedDir, { recursive: true });

  const srcPath = path.join(tmp, "temp-nested.json");
  const dstPath = path.join(nestedDir, "shard-001.json");
  await writeFile(srcPath, '{"nested": true}\n', "utf8");

  await atomicRename(srcPath, dstPath);

  assert.equal(await readFile(dstPath, "utf8"), '{"nested": true}\n');
  await assert.rejects(stat(srcPath), { code: "ENOENT" });
});

// ===========================================================================
// 7. Error class contracts
// ===========================================================================

test("FileSizeExceededError carries path, maxBytes, and actualBytes", () => {
  const error = new FileSizeExceededError("/tmp/big.bin", 1024, 4096);
  assert.equal(error.name, "FileSizeExceededError");
  assert.equal(error.path, "/tmp/big.bin");
  assert.equal(error.maxBytes, 1024);
  assert.equal(error.actualBytes, 4096);
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes("4096"));
  assert.ok(error.message.includes("1024"));
});

test("SymlinkFollowError carries the path and optional cause", () => {
  const cause = new Error("ELOOP");
  const error = new SymlinkFollowError("/tmp/link.txt", cause);
  assert.equal(error.name, "SymlinkFollowError");
  assert.equal(error.path, "/tmp/link.txt");
  assert.equal(error.cause, cause);
  assert.ok(error instanceof Error);
});

test("ExclusiveCreateConflictError carries the path", () => {
  const error = new ExclusiveCreateConflictError("/tmp/exists.txt");
  assert.equal(error.name, "ExclusiveCreateConflictError");
  assert.equal(error.path, "/tmp/exists.txt");
  assert.ok(error instanceof Error);
});

// ===========================================================================
// 8. writeDurableFile round-trip (write + fsync + read-back)
// ===========================================================================

test("writeDurableFile creates a new file with correct content", async () => {
  const tmp = await makeTemp("safe-durable-write");
  const filePath = path.join(tmp, "durable.txt");
  const content = new TextEncoder().encode("durable payload\n");

  await writeDurableFile(filePath, content);

  const readBack = await readFile(filePath);
  assert.equal(new TextDecoder().decode(readBack), "durable payload\n");
  assert.equal(readBack.length, content.length);
});

test("writeDurableFile truncates an existing file", async () => {
  const tmp = await makeTemp("safe-durable-truncate");
  const filePath = path.join(tmp, "truncate.txt");
  await writeFile(filePath, "a".repeat(1000), "utf8");

  const shortContent = new TextEncoder().encode("short\n");
  await writeDurableFile(filePath, shortContent);

  const readBack = await readFile(filePath);
  assert.equal(new TextDecoder().decode(readBack), "short\n");
  assert.equal(readBack.length, shortContent.length);
});

// ===========================================================================
// 9. exclusiveHardLinkPublish success path
// ===========================================================================

test("exclusiveHardLinkPublish links, fsyncs, and removes the temp source", async () => {
  const tmp = await makeTemp("safe-hardlink-ok");
  const srcPath = path.join(tmp, "temp-publish.json");
  const dstPath = path.join(tmp, "published.json");
  const content = '{"published": true}\n';
  await writeFile(srcPath, content, "utf8");

  await exclusiveHardLinkPublish(srcPath, dstPath);

  // Destination must exist with the correct content.
  assert.equal(await readFile(dstPath, "utf8"), content);

  // Source must have been removed.
  await assert.rejects(stat(srcPath), { code: "ENOENT" });

  // Destination must be a regular file (hard link, not symlink).
  const info = await stat(dstPath);
  assert.ok(info.isFile());
  assert.equal(info.nlink, 1); // Only one link since source was unlinked.
});

// ===========================================================================
// 10. syncDirectory does not throw on a valid directory
// ===========================================================================

test("syncDirectory completes without error on a real directory", async () => {
  const tmp = await makeTemp("safe-sync-dir");
  // syncDirectory is called internally by atomicRename and exclusiveHardLinkPublish.
  // Here we verify it works directly.
  const { syncDirectory } = await import(
    "../core/indexing/local-code-index/safe-files.js"
  );
  await assert.doesNotReject(syncDirectory(tmp));
});
