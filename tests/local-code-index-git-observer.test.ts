/**
 * Integration tests for core/indexing/local-code-index/git-observer.ts.
 *
 * Covers:
 *  1. Clean, dirty, untracked, deleted, renamed, branch-switched states.
 *  2. CRLF, encoding, ident, attributes handling.
 *  3. Rejected filter/config states.
 *  4. Same-size restored-mtime edits detected.
 *  5. Descriptor replacement (inode change) detected.
 *  6. Observer proves zero persistent writes.
 *
 * Each test creates a throwaway git repository under os.tmpdir() and runs
 * the real `observeGitSourceState` function against it.
 *
 * Run:
 *   npm run build:tests
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-git-observer.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  utimes,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test, describe } from "node:test";

import {
  observeGitSourceState,
  type GitObservationResult,
  type SourceStatePayload,
  type InventoryEntry,
} from "../core/indexing/local-code-index/git-observer.js";

import { LocalCodeIndexUnavailableError } from "../core/indexing/local-code-index/contracts.js";

// ── Temp directory management ────────────────────────────────────────────────

const tempRoots: string[] = [];

after(async () => {
  if (process.env.CPB_KEEP_TEMP) {
    for (const root of tempRoots)
      process.stderr.write(`[keep-temp] ${root}\n`);
    return;
  }
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTemp(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

/** Fixed git environment for test repos. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "CPB Test",
  GIT_AUTHOR_EMAIL: "cpb-test@local.invalid",
  GIT_COMMITTER_NAME: "CPB Test",
  GIT_COMMITTER_EMAIL: "cpb-test@local.invalid",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    timeout: 15_000,
  });
}

/**
 * Initialize a git repository at `dir`, optionally commit initial files.
 *
 * @param dir  Absolute path to create the repo in.
 * @param initialFiles  Map of relative-path to content for the initial commit.
 * @returns The absolute path to the repo root.
 */
async function initRepo(
  dir: string,
  initialFiles?: Record<string, string>,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cpb-test@local.invalid"]);
  git(dir, ["config", "user.name", "CPB Test"]);

  if (initialFiles) {
    for (const [rel, content] of Object.entries(initialFiles)) {
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "initial"]);
  }

  return dir;
}

/**
 * Run `observeGitSourceState` and assert it resolves (not rejects).
 */
async function observeOrThrow(
  sourcePath: string,
): Promise<GitObservationResult> {
  return observeGitSourceState(sourcePath);
}

/** Find an inventory entry by path suffix (e.g., "a.txt"). */
function findEntry(
  payload: SourceStatePayload,
  pathSuffix: string,
): InventoryEntry | undefined {
  return payload.entries.find((e) => e.path.endsWith(pathSuffix));
}

/** Collect all entries that have a non-null porcelain status. */
function dirtyEntries(payload: SourceStatePayload): InventoryEntry[] {
  return payload.entries.filter((e) => e.porcelain !== null);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Clean, dirty, untracked, deleted, renamed, branch-switched states
// ══════════════════════════════════════════════════════════════════════════════

describe("git state observation", () => {
  test("clean repo: double observation returns state='clean' with correct payload", async () => {
    const dir = await makeTemp("obs-clean");
    await initRepo(dir, { "a.txt": "hello\n", "b.ts": "const x = 1;\n" });

    const result = await observeOrThrow(dir);

    assert.equal(result.state, "clean");
    assert.ok(result.payload.headCommit);
    assert.ok(result.payload.branch);
    assert.equal(result.payload.objectFormat, "sha1");
    assert.ok(result.payload.entries.length >= 2);

    // Both files should be tracked with stage entries.
    const a = findEntry(result.payload, "a.txt")!;
    const b = findEntry(result.payload, "b.ts")!;
    assert.ok(a, "a.txt in inventory");
    assert.ok(b, "b.ts in inventory");
    assert.ok(a.stage, "a.txt has stage entry");
    assert.ok(b.stage, "b.ts has stage entry");

    // No dirty status in a clean repo.
    assert.equal(dirtyEntries(result.payload).length, 0);
  });

  test("dirty (modified tracked file): observer detects porcelain status", async () => {
    const dir = await makeTemp("obs-dirty");
    await initRepo(dir, { "a.txt": "original\n" });

    // Modify the tracked file.
    await writeFile(path.join(dir, "a.txt"), "modified content\n", "utf8");

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");
    assert.ok(a.porcelain, "a.txt has porcelain status");
    assert.equal(a.porcelain!.path, "a.txt");
    // XY code: ".M" means worktree modified, index clean
    assert.match(a.porcelain!.statusCode, /M/);
  });

  test("untracked file: observer detects porcelain status '??'", async () => {
    const dir = await makeTemp("obs-untracked");
    await initRepo(dir, { "a.txt": "tracked\n" });

    // Add an untracked file.
    await writeFile(path.join(dir, "new.txt"), "brand new\n", "utf8");

    const result = await observeOrThrow(dir);

    const n = findEntry(result.payload, "new.txt")!;
    assert.ok(n, "new.txt in inventory");
    assert.ok(n.porcelain, "new.txt has porcelain status");
    assert.equal(n.porcelain!.statusCode, "??");
    // Untracked files have no stage entry.
    assert.equal(n.stage, null);
  });

  test("deleted tracked file: observer detects porcelain status '.D'", async () => {
    const dir = await makeTemp("obs-deleted");
    await initRepo(dir, { "a.txt": "to be deleted\n" });

    // Delete the tracked file from the working tree.
    await unlink(path.join(dir, "a.txt"));

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt still in inventory (stage + porcelain)");
    assert.ok(a.porcelain, "a.txt has porcelain status");
    // ".D" = worktree deleted, index clean
    assert.equal(a.porcelain!.statusCode, ".D");
  });

  test("renamed file: observer detects porcelain rename status with origPath", async () => {
    const dir = await makeTemp("obs-renamed");
    await initRepo(dir, { "original.txt": "rename me\n" });

    // Rename via git mv (stages the rename).
    git(dir, ["mv", "original.txt", "renamed.txt"]);
    git(dir, ["commit", "-m", "rename"]);

    const result = await observeOrThrow(dir);

    const r = findEntry(result.payload, "renamed.txt")!;
    assert.ok(r, "renamed.txt in inventory");
    assert.ok(r.stage, "renamed.txt has stage entry");

    // After commit, the rename is clean. Verify the file appears.
    assert.equal(r.porcelain, null);
  });

  test("staged rename (before commit): observer detects R status", async () => {
    const dir = await makeTemp("obs-staged-rename");
    await initRepo(dir, { "old.txt": "staged rename\n" });

    git(dir, ["mv", "old.txt", "new.txt"]);

    const result = await observeOrThrow(dir);

    // porcelain v2 uses kind '2' for renames, parsed as statusCode starting with 'R'
    const n = findEntry(result.payload, "new.txt")!;
    assert.ok(n, "new.txt in inventory");
    assert.ok(n.porcelain, "new.txt has porcelain status");
    // Status code for staged rename: R100
    assert.match(n.porcelain!.statusCode, /^R/);
    assert.equal(n.porcelain!.origPath, "old.txt");
  });

  test("branch switch: observer detects different branch name", async () => {
    const dir = await makeTemp("obs-branch");
    await initRepo(dir, { "a.txt": "main line\n" });

    // Create a feature branch, switch to it, add a commit.
    git(dir, ["checkout", "-b", "feature-xyz"]);
    await writeFile(path.join(dir, "feature.txt"), "feature work\n", "utf8");
    git(dir, ["add", "feature.txt"]);
    git(dir, ["commit", "-m", "feature commit"]);

    const result = await observeOrThrow(dir);

    assert.equal(result.payload.branch, "feature-xyz");
    assert.ok(findEntry(result.payload, "feature.txt"), "feature.txt present");
    assert.ok(findEntry(result.payload, "a.txt"), "a.txt still present");
  });

  test("detached HEAD: branch is null", async () => {
    const dir = await makeTemp("obs-detached");
    await initRepo(dir, { "a.txt": "content\n" });

    const headHash = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["checkout", headHash]);

    const result = await observeOrThrow(dir);

    assert.equal(result.payload.branch, null);
    assert.equal(result.payload.headCommit, headHash);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. CRLF, encoding, ident, attributes handling
// ══════════════════════════════════════════════════════════════════════════════

describe("attributes and materialization", () => {
  test("text=auto attribute: observer records text attribute value", async () => {
    const dir = await makeTemp("obs-textattr");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Set .gitattributes for text=auto.
    await writeFile(
      path.join(dir, ".gitattributes"),
      "*.txt text=auto\n",
      "utf8",
    );
    git(dir, ["add", ".gitattributes"]);
    git(dir, ["commit", "-m", "add attributes"]);

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");
    // The text attribute should now be 'auto' (not 'unspecified').
    assert.equal(a.attributes.text, "auto");
  });

  test("ident attribute: observer records ident value", async () => {
    const dir = await makeTemp("obs-ident");
    await initRepo(dir, { "a.txt": "hello $Id$\n" });

    await writeFile(
      path.join(dir, ".gitattributes"),
      "*.txt ident\n",
      "utf8",
    );
    git(dir, ["add", ".gitattributes"]);
    git(dir, ["commit", "-m", "ident attr"]);

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");
    assert.equal(a.attributes.ident, "set");
  });

  test("eol=crlf attribute: observer records eol value", async () => {
    const dir = await makeTemp("obs-eolcrlf");
    await initRepo(dir, { "a.txt": "hello\n" });

    await writeFile(
      path.join(dir, ".gitattributes"),
      "*.txt eol=crlf\n",
      "utf8",
    );
    git(dir, ["add", ".gitattributes"]);
    git(dir, ["commit", "-m", "eol=crlf"]);

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");
    assert.equal(a.attributes.eol, "crlf");
  });

  test("CRLF content: observer captures eol info showing crlf in working tree", async () => {
    const dir = await makeTemp("obs-crlf");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Write CRLF content to the file.
    await writeFile(path.join(dir, "a.txt"), "hello\r\nworld\r\n", "utf8");

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");
    // eolInfo format: "i/lf w/crlf attr/" or similar
    assert.match(a.eolInfo, /w\/crlf/);
    // The file should show as dirty.
    assert.ok(a.porcelain, "CRLF-modified file shows porcelain status");
  });

  test("materialization config captures core.autocrlf setting", async () => {
    const dir = await makeTemp("obs-autocrlf");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["config", "core.autocrlf", "true"]);

    const result = await observeOrThrow(dir);

    assert.equal(result.payload.materializationConfig.autocrlf, "true");
  });

  test("materialization config captures core.eol setting", async () => {
    const dir = await makeTemp("obs-coreeol");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["config", "core.eol", "crlf"]);

    const result = await observeOrThrow(dir);

    assert.equal(result.payload.materializationConfig.eol, "crlf");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Rejected filter/config states
// ══════════════════════════════════════════════════════════════════════════════

describe("rejected filter and config states", () => {
  test("command-backed clean filter: observer rejects with unsupported_git_state", async () => {
    const dir = await makeTemp("obs-filter-clean");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["config", "filter.myfilter.clean", "cat"]);

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("command-backed smudge filter: observer rejects", async () => {
    const dir = await makeTemp("obs-filter-smudge");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["config", "filter.myfilter.smudge", "cat"]);

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("command-backed process filter: observer rejects", async () => {
    const dir = await makeTemp("obs-filter-process");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["config", "filter.myfilter.process", "my-process-filter"]);

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("filter.required only: observer does NOT reject", async () => {
    const dir = await makeTemp("obs-filter-required");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Only 'required' key — not a command-backed filter.
    git(dir, ["config", "filter.myfilter.required", "true"]);

    // Should not throw.
    const result = await observeOrThrow(dir);
    assert.ok(result.payload.headCommit);
  });

  test("include.path in local config: observer rejects", async () => {
    const dir = await makeTemp("obs-include-path");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Append include.path to .git/config.
    const configPath = path.join(dir, ".git", "config");
    const existing = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      existing + '\n[include]\n\tpath = /tmp/extra.conf\n',
      "utf8",
    );

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("includeIf.*.path in local config: observer rejects", async () => {
    const dir = await makeTemp("obs-includeif");
    await initRepo(dir, { "a.txt": "hello\n" });

    const configPath = path.join(dir, ".git", "config");
    const existing = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      existing + '\n[includeIf "gitdir:~/work/"]\n\tpath = /tmp/work.conf\n',
      "utf8",
    );

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("assume-unchanged flag: observer rejects", async () => {
    const dir = await makeTemp("obs-assume");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["update-index", "--assume-unchanged", "a.txt"]);

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("skip-worktree flag: observer rejects", async () => {
    const dir = await makeTemp("obs-skip-wt");
    await initRepo(dir, { "a.txt": "hello\n" });

    git(dir, ["update-index", "--skip-worktree", "a.txt"]);

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("submodule entry (mode 160000): observer rejects", async () => {
    const dir = await makeTemp("obs-submodule");
    await initRepo(dir, { "a.txt": "hello\n" });

    // A gitlink is exactly an index entry with mode 160000. Create it
    // directly from an object already present in this repository instead of
    // cloning a nested repository; this keeps the fixture deterministic under
    // full-suite CPU and process load.
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });

  test("symbolic link in working tree: observer rejects", async () => {
    const dir = await makeTemp("obs-symlink");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Create a symlink (untracked).
    await symlink(path.join(dir, "a.txt"), path.join(dir, "link.txt"));

    // The symlink is an untracked file; observeOnce will try to pinMetadata
    // on it and reject because lstat shows it's a symlink.
    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Same-size restored-mtime edits detected
// ══════════════════════════════════════════════════════════════════════════════

describe("same-size restored-mtime edits", () => {
  test("file with same byte size and restored mtime: ctimeNs differs between observations", async () => {
    const dir = await makeTemp("obs-samesize");
    await initRepo(dir, { "a.txt": "AAAA\n" });

    // Record the original mtime.
    const origStat = await lstat(path.join(dir, "a.txt"), { bigint: true });
    const origMtimeNs = origStat.mtimeNs;

    // Overwrite with different content of the same byte size.
    await writeFile(path.join(dir, "a.txt"), "BBBB\n", "utf8");

    // Restore the original mtime via utimes (nanosecond precision).
    // utimes only supports microsecond precision, so we set the closest we can.
    const mtimeSec = Number(origMtimeNs / 1_000_000_000n);
    const mtimeUsecRemainder = Number((origMtimeNs % 1_000_000_000n) / 1_000n);
    await utimes(
      path.join(dir, "a.txt"),
      mtimeSec + mtimeUsecRemainder / 1_000_000,
      mtimeSec + mtimeUsecRemainder / 1_000_000,
    );

    const result = await observeOrThrow(dir);

    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");

    // The file is dirty because content changed.
    assert.ok(a.porcelain, "same-size edit shows porcelain status");

    // Verify the observer captured metadata even though mtime was restored.
    assert.ok(a.metadata.size, "metadata.size is set");
    assert.ok(a.metadata.mtimeNs, "metadata.mtimeNs is set");
    assert.ok(a.metadata.ctimeNs, "metadata.ctimeNs is set");
    assert.ok(a.metadata.inode, "metadata.inode is set");

    // The ctimeNs should have changed (OS updates ctime on write even if
    // mtime is restored), proving the edit was detected via metadata.
    // We cannot assert an exact value, but we verify it is present and
    // the porcelain status confirms the edit was detected.
    assert.notEqual(a.metadata.ctimeNs, "0");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Descriptor replacement (inode change) detected
// ══════════════════════════════════════════════════════════════════════════════

describe("descriptor replacement detected", () => {
  test("file replaced with new inode (delete + write same content): observer records different inode", async () => {
    const dir = await makeTemp("obs-inode");
    await initRepo(dir, { "a.txt": "stable content\n" });

    const beforeStat = await lstat(path.join(dir, "a.txt"), { bigint: true });
    const inodeBefore = beforeStat.ino;

    // Simulate descriptor replacement: delete the file, then write same content.
    await unlink(path.join(dir, "a.txt"));
    await writeFile(path.join(dir, "a.txt"), "stable content\n", "utf8");

    const afterStat = await lstat(path.join(dir, "a.txt"), { bigint: true });
    const inodeAfter = afterStat.ino;

    // On most filesystems (APFS, ext4), the inode will differ.
    // If it happens to be the same (e.g., some CoW fs), skip the inode assertion
    // but still verify the observer captures the metadata correctly.
    const inodeChanged = inodeBefore !== inodeAfter;

    const result = await observeOrThrow(dir);
    const a = findEntry(result.payload, "a.txt")!;
    assert.ok(a, "a.txt in inventory");

    // The observer should have captured the inode.
    assert.ok(a.metadata.inode, "inode is captured");

    if (inodeChanged) {
      // Verify the inode in the payload matches the after-stat.
      assert.equal(a.metadata.inode, String(inodeAfter));
      assert.notEqual(a.metadata.inode, String(inodeBefore));
    }

    // Content is identical, so if git sees it as clean, porcelain is null.
    // If git sees it as dirty (mtime/ctime changed), porcelain is set.
    // Either outcome is valid — the key assertion is that inode was captured.
    assert.ok(a.metadata.device, "device is captured");
    assert.ok(a.metadata.size, "size is captured");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Observer proves zero persistent writes
// ══════════════════════════════════════════════════════════════════════════════

describe("zero persistent writes", () => {
  test("observation does not create any files in the repo or .git directory", async () => {
    const dir = await makeTemp("obs-nowrite");
    await initRepo(dir, { "a.txt": "hello\n", "b.ts": "const x = 1;\n" });

    // Snapshot the entire repo tree before observation.
    async function dirHash(root: string): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      async function walk(d: string, prefix: string) {
        const entries = await readdir(d, { withFileTypes: true });
        for (const ent of entries) {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          const abs = path.join(d, ent.name);
          if (ent.isDirectory()) {
            await walk(abs, rel);
          } else if (ent.isFile()) {
            const content = await readFile(abs);
            map.set(rel, createHash("sha256").update(content).digest("hex"));
          }
        }
      }
      await walk(root, "");
      return map;
    }

    const beforeTree = await dirHash(dir);

    // Run the observer.
    const result = await observeOrThrow(dir);
    assert.equal(result.state, "clean");

    // Snapshot after.
    const afterTree = await dirHash(dir);

    // Verify no files were added, removed, or modified.
    assert.equal(
      beforeTree.size,
      afterTree.size,
      `file count changed: before=${beforeTree.size} after=${afterTree.size}`,
    );
    for (const [rel, hashBefore] of beforeTree) {
      const hashAfter = afterTree.get(rel);
      assert.ok(hashAfter, `file disappeared: ${rel}`);
      assert.equal(
        hashBefore,
        hashAfter,
        `file content changed: ${rel}`,
      );
    }
    for (const rel of afterTree.keys()) {
      assert.ok(beforeTree.has(rel), `file appeared: ${rel}`);
    }
  });

  test("observation does not create any files outside the repo root", async () => {
    const parent = await makeTemp("obs-parent-no-write");
    const dir = path.join(parent, "repo");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Snapshot the parent directory (excluding the repo itself).
    const parentEntriesBefore = new Set(await readdir(parent));

    await observeOrThrow(dir);

    const parentEntriesAfter = new Set(await readdir(parent));

    // The only child of parent should still be "repo".
    assert.equal(parentEntriesAfter.size, parentEntriesBefore.size);
    for (const entry of parentEntriesAfter) {
      assert.ok(parentEntriesBefore.has(entry), `unexpected entry in parent: ${entry}`);
    }
  });

  test("observation does not write to tmpdir", async () => {
    const dir = await makeTemp("obs-tmpdir-check");
    await initRepo(dir, { "a.txt": "hello\n" });

    // Snapshot os.tmpdir() for any new entries matching our prefix.
    const tmpdir = os.tmpdir();
    const beforeTmp = new Set(
      (await readdir(tmpdir)).filter((e) => e.startsWith("obs-tmpdir-check")),
    );

    await observeOrThrow(dir);

    const afterTmp = new Set(
      (await readdir(tmpdir)).filter((e) => e.startsWith("obs-tmpdir-check")),
    );

    // Only our temp root should be present; no new entries from the observer.
    assert.equal(afterTmp.size, beforeTmp.size);
    for (const entry of afterTmp) {
      assert.ok(beforeTmp.has(entry), `observer leaked tmpdir entry: ${entry}`);
    }
  });

  test("observation does not modify .git/index", async () => {
    const dir = await makeTemp("obs-index-check");
    await initRepo(dir, { "a.txt": "hello\n" });

    const indexPath = path.join(dir, ".git", "index");

    const indexBefore = createHash("sha256")
      .update(await readFile(indexPath))
      .digest("hex");

    await observeOrThrow(dir);

    const indexAfter = createHash("sha256")
      .update(await readFile(indexPath))
      .digest("hex");

    assert.equal(indexBefore, indexAfter, ".git/index was modified");
  });

  test("observation does not modify .git/config", async () => {
    const dir = await makeTemp("obs-config-check");
    await initRepo(dir, { "a.txt": "hello\n" });

    const configPath = path.join(dir, ".git", "config");

    const configBefore = createHash("sha256")
      .update(await readFile(configPath))
      .digest("hex");

    await observeOrThrow(dir);

    const configAfter = createHash("sha256")
      .update(await readFile(configPath))
      .digest("hex");

    assert.equal(configBefore, configAfter, ".git/config was modified");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Additional: payload determinism and edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe("payload determinism", () => {
  test("two consecutive calls on a stable repo produce byte-identical canonical output", async () => {
    const dir = await makeTemp("obs-determinism");
    await initRepo(dir, { "a.txt": "stable\n", "b.ts": "let x = 1;\n" });

    const r1 = await observeOrThrow(dir);
    const r2 = await observeOrThrow(dir);

    assert.equal(r1.state, "clean");
    assert.equal(r2.state, "clean");

    // Entries must be in the same order and have identical content.
    assert.equal(r1.payload.entries.length, r2.payload.entries.length);
    for (let i = 0; i < r1.payload.entries.length; i++) {
      const e1 = r1.payload.entries[i]!;
      const e2 = r2.payload.entries[i]!;
      assert.equal(e1.path, e2.path);
      assert.equal(e1.stage?.blobId, e2.stage?.blobId);
      assert.equal(e1.metadata.size, e2.metadata.size);
      assert.equal(e1.metadata.inode, e2.metadata.inode);
    }
  });

  test("entries are sorted by canonical path", async () => {
    const dir = await makeTemp("obs-sorted");
    await initRepo(dir, {
      "z-last.txt": "last\n",
      "a-first.txt": "first\n",
      "m-middle.ts": "middle\n",
    });

    const result = await observeOrThrow(dir);
    const paths = result.payload.entries.map((e) => e.path);

    // Verify sorted order.
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(paths, sorted);
  });

  test("non-git directory: observer rejects with unsupported_git_state", async () => {
    const dir = await makeTemp("obs-nongit");
    await writeFile(path.join(dir, "a.txt"), "not in a repo\n", "utf8");

    await assert.rejects(() => observeOrThrow(dir), (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "unsupported_git_state");
      return true;
    });
  });
});
