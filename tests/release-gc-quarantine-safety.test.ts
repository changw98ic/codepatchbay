import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, lstat, mkdir, readFile, rename, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  _quarantineReleaseDirectoryForTests,
  listReleases,
} from "../server/services/release/release-store.js";
import { tempRoot } from "./helpers.js";

test("release GC isolates a verified directory and retains recoverable evidence", async () => {
  const store = await tempRoot("cpb-release-gc-quarantine");
  const release = path.join(store, "release-1");
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "preserve\n", "utf8");

  const quarantine = await _quarantineReleaseDirectoryForTests(store, release, "release-1");

  await assert.rejects(access(release), { code: "ENOENT" });
  assert.equal(await readFile(path.join(quarantine, "sentinel.txt"), "utf8"), "preserve\n");
  assert.equal(path.dirname(quarantine), path.join(store, ".gc-quarantine"));
});

test("release GC preserves a same-generation ABA replacement that appears before isolation", async () => {
  const store = await tempRoot("cpb-release-gc-successor");
  const release = path.join(store, "release-2");
  const displaced = path.join(store, "release-2-original");
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "original\n", "utf8");
  const originalStat = await lstat(release);

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(store, release, "release-2", {
      async beforeRename() {
        await rename(release, displaced);
        await mkdir(release);
        await writeFile(path.join(release, "sentinel.txt"), "successor\n", "utf8");
        await utimes(release, originalStat.atime, originalStat.mtime);
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        originalEvidence?: "verified" | "unknown";
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: { canonical?: string };
      };
      assert.equal(failure.code, "RELEASE_GC_SOURCE_CHANGED");
      assert.equal(failure.originalEvidence, "unknown");
      assert.equal(failure.recoveryPaths, undefined);
      assert.deepEqual(failure.attemptedPaths, { canonical: release });
      for (const advertisedPath of Object.values(failure.recoveryPaths || {})) {
        assert.equal(readFileSync(path.join(advertisedPath, "sentinel.txt"), "utf8"), "original\n");
      }
      return true;
    },
  );

  assert.equal(await readFile(path.join(release, "sentinel.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(displaced, "sentinel.txt"), "utf8"), "original\n");
});

test("release GC refuses success when the quarantine path is replaced after verification", async () => {
  const store = await tempRoot("cpb-release-gc-post-verify-replacement");
  const release = path.join(store, "release-3");
  let preservedQuarantine = "";
  let replacedQuarantine = "";
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "original\n", "utf8");

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(store, release, "release-3", {
      async beforeFinalGenerationCheck({ quarantinePath }) {
        replacedQuarantine = quarantinePath;
        preservedQuarantine = `${quarantinePath}.preserved`;
        await rename(quarantinePath, preservedQuarantine);
        await mkdir(quarantinePath);
        await writeFile(path.join(quarantinePath, "sentinel.txt"), "replacement\n", "utf8");
      },
    }),
    (err: unknown) => {
      const failure = err as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: { canonical?: string; quarantine?: string };
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_GC_QUARANTINE_COMMITTED_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, undefined);
      assert.equal(failure.quarantinePreserved, false);
      assert.equal(failure.originalEvidence, "unknown");
      assert.equal(failure.recoveryPaths, undefined);
      assert.deepEqual(failure.attemptedPaths, {
        canonical: release,
        quarantine: replacedQuarantine,
      });
      for (const advertisedPath of Object.values(failure.recoveryPaths || {})) {
        assert.equal(readFileSync(path.join(advertisedPath, "sentinel.txt"), "utf8"), "original\n");
      }
      return true;
    },
  );

  assert.equal(await readFile(path.join(preservedQuarantine, "sentinel.txt"), "utf8"), "original\n");
});

test("release GC never advertises a quarantine whose original content changed in place", async () => {
  const store = await tempRoot("cpb-release-gc-content-replacement");
  const release = path.join(store, "release-content");
  let quarantine = "";
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "original\n", "utf8");

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(store, release, "release-content", {
      async afterRename({ quarantinePath }) {
        quarantine = quarantinePath;
        await writeFile(path.join(quarantinePath, "sentinel.txt"), "replacement\n", "utf8");
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        quarantinePreserved?: boolean;
        originalEvidence?: "verified" | "unknown";
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: { canonical?: string; quarantine?: string };
      };
      assert.equal(failure.code, "RELEASE_GC_QUARANTINE_COMMITTED_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.quarantinePreserved, false);
      assert.equal(failure.originalEvidence, "unknown");
      assert.equal(failure.recoveryPaths, undefined);
      assert.deepEqual(failure.attemptedPaths, { canonical: release, quarantine });
      for (const advertisedPath of Object.values(failure.recoveryPaths || {})) {
        assert.equal(readFileSync(path.join(advertisedPath, "sentinel.txt"), "utf8"), "original\n");
      }
      return true;
    },
  );

  assert.equal(await readFile(path.join(quarantine, "sentinel.txt"), "utf8"), "replacement\n");
});

test("release GC fails closed and retains both generations when a canonical successor appears after isolation", async () => {
  const store = await tempRoot("cpb-release-gc-post-isolation-successor");
  const release = path.join(store, "release-successor");
  let quarantine = "";
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "original\n", "utf8");

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(store, release, "release-successor", {
      async afterRename({ quarantinePath }) {
        quarantine = quarantinePath;
        await mkdir(release);
        await writeFile(path.join(release, "sentinel.txt"), "successor\n", "utf8");
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        successorPreserved?: boolean;
        originalEvidence?: "verified" | "unknown";
        recoveryPaths?: { quarantine?: string };
        attemptedPaths?: { canonical?: string; quarantine?: string };
        successorPaths?: { canonical?: string };
      };
      assert.equal(failure.code, "RELEASE_GC_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, true);
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.originalEvidence, "verified");
      assert.deepEqual(failure.recoveryPaths, { quarantine });
      assert.deepEqual(failure.attemptedPaths, { canonical: release, quarantine });
      assert.deepEqual(failure.successorPaths, { canonical: release });
      for (const advertisedPath of Object.values(failure.recoveryPaths || {})) {
        assert.equal(readFileSync(path.join(advertisedPath, "sentinel.txt"), "utf8"), "original\n");
      }
      return true;
    },
  );

  assert.equal(await readFile(path.join(release, "sentinel.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(quarantine, "sentinel.txt"), "utf8"), "original\n");
});

test("release GC rejects a symlinked quarantine root without moving the release", async () => {
  const store = await tempRoot("cpb-release-gc-quarantine-symlink");
  const release = path.join(store, "release-safe");
  const external = await tempRoot("cpb-release-gc-quarantine-external");
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "original\n", "utf8");
  await symlink(external, path.join(store, ".gc-quarantine"));

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(store, release, "release-safe"),
    { code: "RELEASE_GC_QUARANTINE_UNSAFE" },
  );

  assert.equal(await readFile(path.join(release, "sentinel.txt"), "utf8"), "original\n");
  assert.deepEqual(await lstat(path.join(store, ".gc-quarantine")).then((info) => info.isSymbolicLink()), true);
});

test("release GC rejects a store beneath a symlinked immediate parent", async () => {
  const root = await tempRoot("cpb-release-gc-parent-symlink");
  const actualParent = path.join(root, "actual-parent");
  const aliasParent = path.join(root, "alias-parent");
  const actualStore = path.join(actualParent, "store");
  const aliasedStore = path.join(aliasParent, "store");
  const actualRelease = path.join(actualStore, "release-parent");
  await mkdir(actualRelease, { recursive: true });
  await writeFile(path.join(actualRelease, "sentinel.txt"), "original\n", "utf8");
  await symlink(actualParent, aliasParent);

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(
      aliasedStore,
      path.join(aliasedStore, "release-parent"),
      "release-parent",
    ),
    { code: "RELEASE_GC_QUARANTINE_UNSAFE" },
  );
  assert.equal(await readFile(path.join(actualRelease, "sentinel.txt"), "utf8"), "original\n");
});

test("release GC reports a committed recovery path when isolation fsync is ambiguous", async () => {
  const store = await tempRoot("cpb-release-gc-fsync-ambiguity");
  const release = path.join(store, "release-fsync");
  let quarantine = "";
  await mkdir(release);
  await writeFile(path.join(release, "sentinel.txt"), "original\n", "utf8");

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(store, release, "release-fsync", {
      afterRename({ quarantinePath }) {
        quarantine = quarantinePath;
      },
      syncDirectory({ phase }) {
        if (phase === "canonical-isolation") throw new Error("injected GC directory fsync failure");
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        originalEvidence?: "verified" | "unknown";
        recoveryPaths?: { quarantine?: string };
        attemptedPaths?: { canonical?: string; quarantine?: string };
      };
      assert.equal(failure.code, "RELEASE_GC_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, quarantine);
      assert.equal(failure.quarantinePreserved, true);
      assert.equal(failure.originalEvidence, "verified");
      assert.deepEqual(failure.recoveryPaths, { quarantine });
      assert.deepEqual(failure.attemptedPaths, { canonical: release, quarantine });
      for (const advertisedPath of Object.values(failure.recoveryPaths || {})) {
        assert.equal(readFileSync(path.join(advertisedPath, "sentinel.txt"), "utf8"), "original\n");
      }
      return true;
    },
  );

  await assert.rejects(access(release), { code: "ENOENT" });
  assert.equal(await readFile(path.join(quarantine, "sentinel.txt"), "utf8"), "original\n");
});

test("release listing ignores GC quarantine directories", async () => {
  const store = await tempRoot("cpb-release-gc-list-ignore");
  const validRelease = path.join(store, "release-visible");
  const quarantinedRelease = path.join(store, ".gc-quarantine", "release-hidden");
  const manifest = (releaseId: string, installedPath: string) => ({
    metadataVersion: 1,
    releaseId,
    sourcePath: "/src",
    installedPath,
    createdAt: "2026-01-01T00:00:00.000Z",
    codeVersion: "1.0.0",
    packageName: "codepatchbay",
    stateFormatVersions: {},
  });

  await mkdir(path.join(validRelease, "release"), { recursive: true });
  await writeFile(
    path.join(validRelease, "release", "manifest.json"),
    `${JSON.stringify(manifest("release-visible", validRelease), null, 2)}\n`,
    "utf8",
  );
  await mkdir(path.join(quarantinedRelease, "release"), { recursive: true });
  await writeFile(
    path.join(quarantinedRelease, "release", "manifest.json"),
    `${JSON.stringify(manifest("release-hidden", quarantinedRelease), null, 2)}\n`,
    "utf8",
  );

  const listed = await listReleases({
    destRoot: store,
    env: { ...process.env, CPB_HOME: path.join(store, "home") },
  });

  assert.deepEqual(listed.releases.map((release) => release.releaseId), ["release-visible"]);
});
